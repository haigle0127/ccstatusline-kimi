const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { aggregateUsage, findModelPricing, normalizeModelForPricing } = require('../out/usageMath');
const { readTranscriptUsage } = require('../out/ccswitchDb');
const { numberValue } = require('../out/sqlite');
const { WIDGETS } = require('../out/widgets');

function record(overrides = {}) {
    return {
        timestamp: 1_793_000_000,
        date: '2026-10-26',
        requestCount: 1,
        providerName: 'Test provider',
        model: 'k3-256k',
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationTokens: 300,
        cacheCreation1hTokens: 100,
        cacheReadTokens: 400,
        totalCost: 0,
        costMultiplier: 1,
        statusCode: 200,
        ...overrides
    };
}

const pricing = new Map([
    ['k3', { modelId: 'k3', input: 1, output: 2, cacheRead: .5, cacheCreation: 3 }],
    ['k3-1', { modelId: 'k3-1', input: 1, output: 1, cacheRead: 1, cacheCreation: 1 }]
]);

test('SQLite numeric fallbacks preserve intentional zero and default missing multipliers', () => {
    assert.equal(numberValue(null, 1), 1);
    assert.equal(numberValue('', 1), 1);
    assert.equal(numberValue(0, 1), 0);
    assert.equal(numberValue('2.5', 1), 2.5);
});

test('status bar model prefers the actual response over configured routing', () => {
    const context = recordedModel => ({
        state: {
            tokenMetrics: { model: recordedModel },
            provider: { name: 'Test provider', settingsConfig: { env: { ANTHROPIC_MODEL: 'configured-model' } } },
            settings: { model: 'sonnet' }
        }
    });
    assert.equal(WIDGETS.model(context('actual-model')).text, 'actual-model');
    assert.match(WIDGETS.model(context('actual-model')).tooltip, /最近一次主链响应/);
    assert.equal(WIDGETS.model(context(undefined)).text, 'configured-model');
});

test('pricing normalization handles context, namespace, dates, and combined dot variants', () => {
    assert.equal(findModelPricing('k3-256k', pricing).modelId, 'k3');
    assert.equal(findModelPricing('moonshot/k3-256k', pricing).modelId, 'k3');
    assert.equal(findModelPricing('k3.1-256k', pricing).modelId, 'k3-1');
    assert.equal(findModelPricing('k3-20261026', pricing).modelId, 'k3');
    assert.ok(normalizeModelForPricing('unknown').length === 0);
    assert.equal(findModelPricing('unpriced-model', pricing), null);
});

test('aggregateUsage uses all token dimensions and correct cache denominator', () => {
    const result = aggregateUsage([record()], pricing, [{ key: '2026-10-26', date: '2026-10-26T00:00:00Z' }]);
    assert.equal(result.summary.realTotalTokens, 1000);
    assert.equal(result.summary.cacheHitRate, 50);
    assert.equal(result.summary.totalRequests, 1);
    assert.equal(result.trends[0].totalTokens, 1000);
    assert.ok(Math.abs(result.summary.totalCost - .00178) < 1e-12);
    assert.equal(result.summary.estimatedCostRequests, 1);
});

test('unpriced requests differ from intentional free requests and stored costs', () => {
    const result = aggregateUsage([
        record({ model: 'missing-price' }),
        record({ model: 'free-model', costMultiplier: 0 }),
        record({ model: 'stored-price', totalCost: .25 })
    ], pricing, []);
    assert.equal(result.summary.unpricedRequests, 1);
    assert.equal(result.summary.estimatedCostRequests, 0);
    assert.equal(result.summary.totalCost, .25);
    const free = aggregateUsage([record({ costMultiplier: 0 })], new Map(), []);
    assert.equal(free.summary.totalCost, 0);
    assert.equal(free.summary.unpricedRequests, 0);
});

test('daily and hourly buckets retain zeros and share summary semantics', () => {
    const buckets = [
        { key: '2026-10-25', date: '2026-10-25T00:00:00Z' },
        { key: '2026-10-26', date: '2026-10-26T00:00:00Z' }
    ];
    const result = aggregateUsage([record({ requestCount: 2, successCount: 1 })], pricing, buckets);
    assert.equal(result.trends.length, 2);
    assert.equal(result.trends[0].totalTokens, 0);
    assert.equal(result.trends[0].cacheHitRate, null);
    assert.equal(result.trends[1].requestCount, 2);
    assert.equal(result.summary.totalRequests, 2);
    assert.equal(result.summary.successRate, 50);
    assert.equal(result.providers[0].totalTokens, result.summary.realTotalTokens);
});

test('transcript streaming chunks deduplicate by message id and prefer final usage', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-test-'));
    const file = path.join(directory, 'session.jsonl');
    const line = (id, outputTokens, stopReason, inputTokens = 10, cacheReadTokens = 2) => JSON.stringify({
        type: 'assistant', timestamp: '2026-10-26T01:00:00.000Z',
        message: { id, model: 'k3-256k', stop_reason: stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens } }
    });
    const lines = [
        line('one', 4, null), line('one', 12, 'end_turn'),
        line('two', 5, 'end_turn'), line('two', 7, 'end_turn'),
        line('three', 9, 'end_turn'), line('three', 999, null),
        line('empty', 0, null, 0, 0),
        '{partial json'
    ];
    fs.writeFileSync(file, lines.join('\n'));
    try {
        const events = readTranscriptUsage(file);
        assert.equal(events.length, 3);
        assert.deepEqual(events.map(event => [event.messageId, event.outputTokens]), [['one', 12], ['two', 7], ['three', 9]]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
