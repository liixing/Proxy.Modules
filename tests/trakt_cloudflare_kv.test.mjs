import assert from "node:assert/strict";
import test from "node:test";

import { pipelineCloudflareKv } from "../lib/trakt-cache/cloudflare-kv.js";
import { getKvConfig, pipelineKv } from "../lib/trakt-cache/kv-client.js";

function createMemoryKv() {
    const records = new Map();

    return {
        async get(key) {
            const record = records.get(key);
            if (!record) {
                return null;
            }
            if (record.expiresAt && record.expiresAt <= Date.now()) {
                records.delete(key);
                return null;
            }
            return record.value;
        },
        async put(key, value, options = {}) {
            const ttl = Number(options.expirationTtl);
            records.set(key, {
                value,
                expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null,
            });
        },
        async delete(key) {
            records.delete(key);
        },
        async list({ prefix = "", cursor = "", limit = 100 } = {}) {
            const keys = [...records.keys()].filter((key) => key.startsWith(prefix)).sort();
            const start = cursor ? Number(cursor) : 0;
            const page = keys.slice(start, start + limit);
            const next = start + limit;
            return {
                keys: page.map((name) => ({ name })),
                list_complete: next >= keys.length,
                cursor: String(next),
            };
        },
    };
}

test("Cloudflare KV pipeline stores JSON, applies TTL, and scans by prefix", async () => {
    const kv = createMemoryKv();
    const entry = { status: 2, expiresAt: Date.now() + 5_000, translation: { title: "标题" } };

    await pipelineCloudflareKv(kv, [
        ["JSON.MSET", "trakt:translation:movies:1", "$", JSON.stringify(entry)],
        ["EXPIRE", "trakt:translation:movies:1", 86_400],
    ]);

    const [values] = await pipelineCloudflareKv(kv, [["JSON.MGET", "trakt:translation:movies:1", "trakt:translation:movies:2", "$"]]);
    assert.equal(values[0].translation.title, "标题");
    assert.equal(values[1], null);

    const readOptions = [];
    const originalGet = kv.get.bind(kv);
    kv.get = async (key, options) => {
        readOptions.push(options);
        return originalGet(key);
    };
    const ordered = await pipelineCloudflareKv(kv, [
        ["JSON.GET", "trakt:translation:movies:1", "$"],
        ["JSON.GET", "missing", "$"],
        ["PTTL", "trakt:translation:movies:1"],
    ]);
    assert.equal(ordered[0].translation.title, "标题");
    assert.equal(ordered[1], null);
    assert.ok(ordered[2] > 0);
    assert.deepEqual(readOptions[0], { type: "json", cacheTtl: 60 });

    const [missingTtl] = await pipelineCloudflareKv(kv, [["PTTL", "trakt:translation:movies:2"]]);
    assert.equal(missingTtl, -2);

    const [scan] = await pipelineCloudflareKv(kv, [["SCAN", "0", "MATCH", "trakt:translation:movies:*", "COUNT", 10]]);
    assert.deepEqual(scan, ["0", ["trakt:translation:movies:1"]]);

    await pipelineCloudflareKv(kv, [["DEL", "trakt:translation:movies:1"]]);
    const [afterDelete] = await pipelineCloudflareKv(kv, [["JSON.GET", "trakt:translation:movies:1", "$"]]);
    assert.equal(afterDelete, null);
});

test("getKvConfig prefers Upstash REST and otherwise uses the Cloudflare binding", () => {
    const previousUrl = process.env.KV_REST_API_URL;
    const previousToken = process.env.KV_REST_API_TOKEN;
    const previousBinding = globalThis.__CF_KV;

    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "token";
    globalThis.__CF_KV = { marker: true };
    assert.equal(getKvConfig().url, "https://kv.example");

    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    assert.equal(getKvConfig().kind, "cloudflare");

    if (previousUrl === undefined) {
        delete process.env.KV_REST_API_URL;
    } else {
        process.env.KV_REST_API_URL = previousUrl;
    }
    if (previousToken === undefined) {
        delete process.env.KV_REST_API_TOKEN;
    } else {
        process.env.KV_REST_API_TOKEN = previousToken;
    }
    globalThis.__CF_KV = previousBinding;
});

test("pipelineKv dispatches Cloudflare bindings without calling Upstash", async () => {
    const kv = createMemoryKv();
    await pipelineKv({ kind: "cloudflare", kv }, [["JSON.SET", "demo", "$", JSON.stringify({ ok: true })]]);
    const [value] = await pipelineKv({ kind: "cloudflare", kv }, [["JSON.GET", "demo", "$"]]);
    assert.equal(value.ok, true);
});
