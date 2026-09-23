const CF_KV_MIN_TTL_SECONDS = 60;

function parseStoredValue(raw) {
    if (raw === undefined || raw === null || raw === "") {
        return null;
    }

    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    return raw && typeof raw === "object" ? raw : null;
}

function collectExpireSeconds(commands) {
    const expires = new Map();
    commands.forEach((command) => {
        if (command[0] === "EXPIRE") {
            const seconds = Number(command[2]);
            if (Number.isFinite(seconds) && seconds > 0) {
                expires.set(command[1], seconds);
            }
        }
    });
    return expires;
}

async function readJsonValue(kv, key) {
    return parseStoredValue(await kv.get(key));
}

async function writeJsonValue(kv, key, rawJson, expireSeconds) {
    const options = {};
    if (Number.isFinite(expireSeconds) && expireSeconds > 0) {
        options.expirationTtl = Math.max(CF_KV_MIN_TTL_SECONDS, Math.floor(expireSeconds));
    }
    await kv.put(key, String(rawJson), options);
}

async function pttl(kv, key) {
    const value = await readJsonValue(kv, key);
    if (!value) {
        return -2;
    }
    const expiresAt = Number(value.expiresAt);
    if (!Number.isFinite(expiresAt)) {
        return -1;
    }
    return Math.max(0, Math.trunc(expiresAt - Date.now()));
}

function scanPrefix(pattern) {
    const source = String(pattern || "");
    return source.endsWith("*") ? source.slice(0, -1) : source;
}

async function scan(kv, command) {
    const cursor = String(command[1] || "0");
    const pattern = command[3];
    const count = Number(command[5]);
    const options = {
        prefix: scanPrefix(pattern),
        limit: Math.min(1000, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 100)),
    };
    if (cursor && cursor !== "0") {
        options.cursor = cursor;
    }

    const listed = await kv.list(options);
    const nextCursor = listed.list_complete ? "0" : String(listed.cursor || "0");
    const keys = Array.isArray(listed.keys) ? listed.keys.map((item) => item.name) : [];
    return [nextCursor, keys];
}

async function pipelineCloudflareKv(kv, commands) {
    const expires = collectExpireSeconds(commands);
    const results = [];

    for (const command of commands) {
        const operation = command[0];
        if (operation === "EXPIRE") {
            results.push(1);
            continue;
        }

        if (operation === "JSON.MGET") {
            const keys = command.slice(1, -1);
            results.push(await Promise.all(keys.map((key) => readJsonValue(kv, key))));
            continue;
        }

        if (operation === "JSON.GET") {
            results.push(await readJsonValue(kv, command[1]));
            continue;
        }

        if (operation === "JSON.SET") {
            await writeJsonValue(kv, command[1], command[3], expires.get(command[1]));
            results.push("OK");
            continue;
        }

        if (operation === "JSON.MSET") {
            const args = command.slice(1);
            const writes = [];
            for (let index = 0; index < args.length; index += 3) {
                writes.push(writeJsonValue(kv, args[index], args[index + 2], expires.get(args[index])));
            }
            await Promise.all(writes);
            results.push("OK");
            continue;
        }

        if (operation === "DEL") {
            await kv.delete(command[1]);
            results.push(1);
            continue;
        }

        if (operation === "PTTL") {
            results.push(await pttl(kv, command[1]));
            continue;
        }

        if (operation === "SCAN") {
            results.push(await scan(kv, command));
            continue;
        }

        throw new Error(`Unsupported Cloudflare KV command ${operation}`);
    }

    return results;
}

module.exports = {
    pipelineCloudflareKv,
};
