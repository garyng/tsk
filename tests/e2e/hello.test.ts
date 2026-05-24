import * as assert from 'node:assert';

suite('smoke', () => {
    test('arithmetic holds inside the extension host', () => {
        assert.strictEqual(1 + 1, 2);
    });
});
