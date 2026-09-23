const CF_KV_MIN_TTL_SECONDS = 60;
const CF_KV_READ_CACHE_TTL_SECONDS = 60;
const READ_OPERATIONS = new Set(["JSON.GET", "JSON.MGET", "PTTL", "SCAN"]);

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
    return parseStoredValue(await kv.get(key, { type: "json", cacheTtl: CF_KV_READ_CACHE_TTL_SECONDS }));
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

async function executeRead(kv, command) {
    const operation = command[0];
    if (operation === "JSON.MGET") {
        return Promise.all(command.slice(1, -1).map((key) => readJsonValue(kv, key)));
    }
    if (operation === "JSON.GET") {
        return readJsonValue(kv, command[1]);
    }
    if (operation === "PTTL") {
        return pttl(kv, command[1]);
    }
    if (operation === "SCAN") {
        return scan(kv, command);
    }
    throw new Error(`Unsupported Cloudflare KV command ${operation}`);
}

async function executeWrite(kv, command, expires) {
    const operation = command[0];
    if (operation === "EXPIRE") {
        return 1;
    }
    if (operation === "JSON.SET") {
        await writeJsonValue(kv, command[1], command[3], expires.get(command[1]));
        return "OK";
    }
    if (operation === "JSON.MSET") {
        const args = command.slice(1);
        const writes = [];
        for (let index = 0; index < args.length; index += 3) {
            writes.push(writeJsonValue(kv, args[index], args[index + 2], expires.get(args[index])));
        }
        await Promise.all(writes);
        return "OK";
    }
    if (operation === "DEL") {
        await kv.delete(command[1]);
        return 1;
    }
    throw new Error(`Unsupported Cloudflare KV command ${operation}`);
}

async function pipelineCloudflareKv(kv, commands) {
    const expires = collectExpireSeconds(commands);
    const results = new Array(commands.length);
    let index = 0;

    while (index < commands.length) {
        if (READ_OPERATIONS.has(commands[index][0])) {
            const start = index;
            index += 1;
            while (index < commands.length && READ_OPERATIONS.has(commands[index][0])) {
                index += 1;
            }
            const batch = await Promise.all(commands.slice(start, index).map((command) => executeRead(kv, command)));
            for (let offset = 0; offset < batch.length; offset += 1) {
                results[start + offset] = batch[offset];
            }
            continue;
        }

        results[index] = await executeWrite(kv, commands[index], expires);
        index += 1;
    }

    return results;
}

module.exports = {
    pipelineCloudflareKv,
};
