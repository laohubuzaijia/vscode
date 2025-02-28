/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { groupBy } from 'vs/base/common/arrays';
import { disposableTimeout } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable, IReference, toDisposable } from 'vs/base/common/lifecycle';
import { URI, UriComponents } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ExtHostTestingResource } from 'vs/workbench/api/common/extHost.protocol';
import { ObservableValue } from 'vs/workbench/contrib/testing/common/observableValue';
import { StoredValue } from 'vs/workbench/contrib/testing/common/storedValue';
import { AbstractIncrementalTestCollection, getTestSubscriptionKey, IncrementalTestCollectionItem, InternalTestItem, RunTestsRequest, TestDiffOpType, TestIdWithSrc, TestsDiff } from 'vs/workbench/contrib/testing/common/testCollection';
import { TestingContextKeys } from 'vs/workbench/contrib/testing/common/testingContextKeys';
import { ITestResult, LiveTestResult } from 'vs/workbench/contrib/testing/common/testResult';
import { ITestResultService } from 'vs/workbench/contrib/testing/common/testResultService';
import { IMainThreadTestCollection, ITestRootProvider, ITestService, MainTestController, TestDiffListener } from 'vs/workbench/contrib/testing/common/testService';

type TestLocationIdent = { resource: ExtHostTestingResource, uri: URI };

const workspaceUnsubscribeDelay = 30_000;
const documentUnsubscribeDelay = 5_000;

export class TestService extends Disposable implements ITestService {
	declare readonly _serviceBrand: undefined;
	private testControllers = new Map<string, MainTestController>();
	private readonly testSubscriptions = new Map<string, {
		collection: MainThreadTestCollection;
		ident: TestLocationIdent;
		onDiff: Emitter<TestsDiff>;
		disposeTimeout?: IDisposable,
		listeners: number;
	}>();

	private readonly subscribeEmitter = new Emitter<TestLocationIdent>();
	private readonly unsubscribeEmitter = new Emitter<TestLocationIdent>();
	private readonly busyStateChangeEmitter = new Emitter<TestLocationIdent & { busy: boolean }>();
	private readonly changeProvidersEmitter = new Emitter<{ delta: number }>();
	private readonly providerCount: IContextKey<number>;
	private readonly hasRunnable: IContextKey<boolean>;
	private readonly hasDebuggable: IContextKey<boolean>;
	private readonly runningTests = new Map<RunTestsRequest, CancellationTokenSource>();
	private readonly rootProviders = new Set<ITestRootProvider>();

	public readonly excludeTests = ObservableValue.stored(new StoredValue<ReadonlySet<string>>({
		key: 'excludedTestItems',
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.USER,
		serialization: {
			deserialize: v => new Set(JSON.parse(v)),
			serialize: v => JSON.stringify([...v])
		},
	}, this.storageService), new Set());

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITestResultService private readonly testResults: ITestResultService,
	) {
		super();
		this.providerCount = TestingContextKeys.providerCount.bindTo(contextKeyService);
		this.hasDebuggable = TestingContextKeys.hasDebuggableTests.bindTo(contextKeyService);
		this.hasRunnable = TestingContextKeys.hasRunnableTests.bindTo(contextKeyService);
	}

	/**
	 * @inheritdoc
	 */
	public async expandTest(test: TestIdWithSrc, levels: number) {
		await this.testControllers.get(test.src.provider)?.expandTest(test, levels);
	}

	/**
	 * @inheritdoc
	 */
	public clearExcludedTests() {
		this.excludeTests.value = new Set();
	}

	/**
	 * @inheritdoc
	 */
	public setTestExcluded(testId: string, exclude = !this.excludeTests.value.has(testId)) {
		const newSet = new Set(this.excludeTests.value);
		if (exclude) {
			newSet.add(testId);
		} else {
			newSet.delete(testId);
		}

		if (newSet.size !== this.excludeTests.value.size) {
			this.excludeTests.value = newSet;
		}
	}

	/**
	 * Gets currently running tests.
	 */
	public get testRuns() {
		return this.runningTests.keys();
	}

	/**
	 * Gets the current provider count.
	 */
	public get providers() {
		return this.providerCount.get() || 0;
	}

	/**
	 * Fired when extension hosts should pull events from their test factories.
	 */
	public readonly onShouldSubscribe = this.subscribeEmitter.event;

	/**
	 * Fired when extension hosts should stop pulling events from their test factories.
	 */
	public readonly onShouldUnsubscribe = this.unsubscribeEmitter.event;

	/**
	 * Fired when the number of providers change.
	 */
	public readonly onDidChangeProviders = this.changeProvidersEmitter.event;

	/**
	 * @inheritdoc
	 */
	public readonly onBusyStateChange = this.busyStateChangeEmitter.event;

	/**
	 * @inheritdoc
	 */
	public get subscriptions() {
		return [...this.testSubscriptions].map(([, s]) => s.ident);
	}

	/**
	 * @inheritdoc
	 */
	public cancelTestRun(req: RunTestsRequest) {
		this.runningTests.get(req)?.cancel();
	}

	/**
	 * @inheritdoc
	 */
	public async lookupTest(test: TestIdWithSrc) {
		for (const { collection } of this.testSubscriptions.values()) {
			const node = collection.getNodeById(test.testId);
			if (node) {
				return node;
			}
		}

		return this.testControllers.get(test.src.provider)?.lookupTest(test);
	}

	/**
	 * @inheritdoc
	 */
	public registerRootProvider(provider: ITestRootProvider) {
		if (this.rootProviders.has(provider)) {
			return toDisposable(() => { });
		}

		this.rootProviders.add(provider);
		for (const { collection } of this.testSubscriptions.values()) {
			collection.updatePendingRoots(1);
		}

		return toDisposable(() => {
			if (this.rootProviders.delete(provider)) {
				for (const { collection } of this.testSubscriptions.values()) {
					collection.updatePendingRoots(-1);
				}
			}
		});
	}


	/**
	 * @inheritdoc
	 */
	public async runTests(req: RunTestsRequest, token = CancellationToken.None): Promise<ITestResult> {
		if (!req.exclude) {
			req.exclude = [...this.excludeTests.value];
		}

		const subscriptions = [...this.testSubscriptions.values()]
			.filter(v => req.tests.some(t => v.collection.getNodeById(t.testId)))
			.map(s => this.subscribeToDiffs(s.ident.resource, s.ident.uri));
		const result = this.testResults.push(LiveTestResult.from(subscriptions.map(s => s.object), req));

		try {
			const tests = groupBy(req.tests, (a, b) => a.src.provider === b.src.provider ? 0 : 1);
			const cancelSource = new CancellationTokenSource(token);
			this.runningTests.set(req, cancelSource);

			const requests = tests.map(
				group => this.testControllers.get(group[0].src.provider)?.runTests(
					{
						runId: result.id,
						debug: req.debug,
						excludeExtIds: req.exclude ?? [],
						tests: group,
					},
					cancelSource.token,
				).catch(err => {
					this.notificationService.error(localize('testError', 'An error occurred attempting to run tests: {0}', err.message));
				})
			);

			await Promise.all(requests);
			return result;
		} finally {
			this.runningTests.delete(req);
			subscriptions.forEach(s => s.dispose());
			result.markComplete();
		}
	}

	/**
	 * @inheritdoc
	 */
	public resubscribeToAllTests() {
		for (const subscription of this.testSubscriptions.values()) {
			this.unsubscribeEmitter.fire(subscription.ident);
			const diff = subscription.collection.clear();
			subscription.onDiff.fire(diff);
			subscription.collection.pendingRootProviders = this.rootProviders.size;
			this.subscribeEmitter.fire(subscription.ident);
		}
	}

	/**
	 * @inheritdoc
	 */
	public subscribeToDiffs(resource: ExtHostTestingResource, uri: URI, acceptDiff?: TestDiffListener): IReference<IMainThreadTestCollection> {
		const subscriptionKey = getTestSubscriptionKey(resource, uri);
		let subscription = this.testSubscriptions.get(subscriptionKey);
		if (!subscription) {
			subscription = {
				ident: { resource, uri },
				collection: new MainThreadTestCollection(
					this.rootProviders.size,
					this.expandTest.bind(this),
				),
				listeners: 0,
				onDiff: new Emitter(),
			};

			subscription.collection.onDidRetireTest(testId => {
				for (const result of this.testResults.results) {
					if (result instanceof LiveTestResult) {
						result.retire(testId);
					}
				}
			});

			this.subscribeEmitter.fire({ resource, uri });
			this.testSubscriptions.set(subscriptionKey, subscription);
		} else if (subscription.disposeTimeout) {
			subscription.disposeTimeout.dispose();
			subscription.disposeTimeout = undefined;
		}

		subscription.listeners++;

		if (acceptDiff) {
			acceptDiff(subscription.collection.getReviverDiff());
		}

		const listener = acceptDiff && subscription.onDiff.event(acceptDiff);
		return {
			object: subscription.collection,
			dispose: () => {
				listener?.dispose();

				if (--subscription!.listeners > 0) {
					return;
				}


				subscription!.disposeTimeout = disposableTimeout(
					() => {
						this.unsubscribeEmitter.fire({ resource, uri });
						this.testSubscriptions.delete(subscriptionKey);
					},
					resource === ExtHostTestingResource.TextDocument ? documentUnsubscribeDelay : workspaceUnsubscribeDelay,
				);
			}
		};
	}

	/**
	 * @inheritdoc
	 */
	public publishDiff(resource: ExtHostTestingResource, uri: UriComponents, diff: TestsDiff) {
		const sub = this.testSubscriptions.get(getTestSubscriptionKey(resource, URI.revive(uri)));
		if (!sub) {
			return;
		}

		sub.collection.apply(diff);
		sub.onDiff.fire(diff);
		this.hasDebuggable.set(!!this.findTest(t => t.item.debuggable));
		this.hasRunnable.set(!!this.findTest(t => t.item.runnable));
	}

	/**
	 * @inheritdoc
	 */
	public registerTestController(id: string, controller: MainTestController): IDisposable {
		this.testControllers.set(id, controller);
		this.providerCount.set(this.testControllers.size);
		this.changeProvidersEmitter.fire({ delta: 1 });

		return toDisposable(() => {
			if (this.testControllers.delete(id)) {
				this.providerCount.set(this.testControllers.size);
				this.changeProvidersEmitter.fire({ delta: -1 });
			}
		});
	}

	private findTest(predicate: (t: InternalTestItem) => boolean): InternalTestItem | undefined {
		for (const { collection } of this.testSubscriptions.values()) {
			for (const test of collection.all) {
				if (predicate(test)) {
					return test;
				}
			}
		}

		return undefined;
	}
}

export class MainThreadTestCollection extends AbstractIncrementalTestCollection<IncrementalTestCollectionItem> implements IMainThreadTestCollection {
	private pendingRootChangeEmitter = new Emitter<number>();
	private busyProvidersChangeEmitter = new Emitter<number>();
	private retireTestEmitter = new Emitter<string>();
	private expandPromises = new WeakMap<IncrementalTestCollectionItem, {
		pendingLvl: number;
		doneLvl: number;
		prom: Promise<void>;
	}>();

	/**
	 * @inheritdoc
	 */
	public get pendingRootProviders() {
		return this.pendingRootCount;
	}

	/**
	 * Sets the number of pending root providers.
	 */
	public set pendingRootProviders(count: number) {
		this.pendingRootCount = count;
		this.pendingRootChangeEmitter.fire(count);
	}

	/**
	 * @inheritdoc
	 */
	public get busyProviders() {
		return this.busyProviderCount;
	}

	/**
	 * @inheritdoc
	 */
	public get rootIds() {
		return this.roots;
	}

	/**
	 * @inheritdoc
	 */
	public get all() {
		return this.getIterator();
	}

	public readonly onPendingRootProvidersChange = this.pendingRootChangeEmitter.event;
	public readonly onBusyProvidersChange = this.busyProvidersChangeEmitter.event;
	public readonly onDidRetireTest = this.retireTestEmitter.event;

	constructor(pendingRootProviders: number, private readonly expandActual: (src: TestIdWithSrc, levels: number) => Promise<void>) {
		super();
		this.pendingRootCount = pendingRootProviders;
	}

	/**
	 * @inheritdoc
	 */
	public expand(testId: string, levels: number): Promise<void> {
		const test = this.items.get(testId);
		if (!test) {
			return Promise.resolve();
		}

		// simple cache to avoid duplicate/unnecessary expansion calls
		const existing = this.expandPromises.get(test);
		if (existing && existing.pendingLvl >= levels) {
			return existing.prom;
		}

		const prom = this.expandActual({ src: test.src, testId: test.item.extId }, levels);
		const record = { doneLvl: existing ? existing.doneLvl : -1, pendingLvl: levels, prom };
		this.expandPromises.set(test, record);

		return prom.then(() => {
			record.doneLvl = levels;
		});
	}

	/**
	 * @inheritdoc
	 */
	public getNodeById(id: string) {
		return this.items.get(id);
	}

	/**
	 * @inheritdoc
	 */
	public getReviverDiff() {
		const ops: TestsDiff = [[TestDiffOpType.DeltaRootsComplete, this.pendingRootCount]];

		const queue = [this.roots];
		while (queue.length) {
			for (const child of queue.pop()!) {
				const item = this.items.get(child)!;
				ops.push([TestDiffOpType.Add, {
					src: item.src,
					expand: item.expand,
					item: item.item,
					parent: item.parent,
				}]);
				queue.push(item.children);
			}
		}

		return ops;
	}


	/**
	 * Applies the diff to the collection.
	 */
	public apply(diff: TestsDiff) {
		let prevBusy = this.busyProviderCount;
		let prevPendingRoots = this.pendingRootCount;
		super.apply(diff);

		if (prevBusy !== this.busyProviderCount) {
			this.busyProvidersChangeEmitter.fire(this.busyProviderCount);
		}
		if (prevPendingRoots !== this.pendingRootCount) {
			this.pendingRootChangeEmitter.fire(this.pendingRootCount);
		}
	}

	/**
	 * Clears everything from the collection, and returns a diff that applies
	 * that action.
	 */
	public clear() {
		const ops: TestsDiff = [];
		for (const root of this.roots) {
			ops.push([TestDiffOpType.Remove, root]);
		}

		this.roots.clear();
		this.items.clear();

		return ops;
	}

	/**
	 * @override
	 */
	protected createItem(internal: InternalTestItem): IncrementalTestCollectionItem {
		return { ...internal, children: new Set() };
	}

	/**
	 * @override
	 */
	protected retireTest(testId: string) {
		this.retireTestEmitter.fire(testId);
	}

	private *getIterator() {
		const queue = [this.rootIds];
		while (queue.length) {
			for (const id of queue.pop()!) {
				const node = this.getNodeById(id)!;
				yield node;
				queue.push(node.children);
			}
		}
	}
}
