const redirectHandler = require("../api/redirect");
const translationsHandler = require("../api/trakt/translations");
const translationsAdminHandler = require("../api/trakt/translations/admin");
const imagesHandler = require("../api/trakt/images");
const creditsHandler = require("../api/trakt/credits");
const peopleNamesHandler = require("../api/trakt/people-names");
const commentTranslationsHandler = require("../api/trakt/comment-translations");
const listTranslationsHandler = require("../api/trakt/list-translations");
const translationOverridesHandler = require("../api/trakt/translation-overrides");

const ROUTES = new Map([
    ["/api/redirect", redirectHandler],
    ["/api/trakt/translations", translationsHandler],
    ["/api/trakt/translations/admin", translationsAdminHandler],
    ["/api/trakt/images", imagesHandler],
    ["/api/trakt/credits", creditsHandler],
    ["/api/trakt/people-names", peopleNamesHandler],
    ["/api/trakt/comment-translations", commentTranslationsHandler],
    ["/api/trakt/list-translations", listTranslationsHandler],
    ["/api/trakt/translation-overrides", translationOverridesHandler],
]);

function applyWorkerEnv(env) {
    if (!globalThis.process) {
        globalThis.process = { env: {} };
    }
    if (!process.env) {
        process.env = {};
    }
    process.env.ADMIN_TOKEN = env.ADMIN_TOKEN || "";
    process.env.TRAKT_API_KEY = env.TRAKT_API_KEY || "";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    globalThis.__CF_KV = env.TRAKT_CACHE || null;
}

function readQuery(url) {
    const query = {};
    url.searchParams.forEach((value, key) => {
        if (query[key] === undefined) {
            query[key] = value;
            return;
        }
        query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    });
    return query;
}

async function toVercelRequest(request, url) {
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
        const raw = await request.text();
        if (raw) {
            try {
                body = JSON.parse(raw);
            } catch {
                body = raw;
            }
        }
    }

    return {
        method: request.method,
        query: readQuery(url),
        headers: Object.fromEntries(request.headers),
        body,
    };
}

function createVercelResponse() {
    let status = 200;
    const headers = new Headers();
    let body = null;

    return {
        res: {
            setHeader(name, value) {
                headers.set(name, value);
            },
            status(code) {
                status = code;
                return {
                    json(payload) {
                        body = JSON.stringify(payload);
                        if (!headers.has("content-type")) {
                            headers.set("content-type", "application/json; charset=utf-8");
                        }
                    },
                    end() {},
                };
            },
        },
        toResponse() {
            const empty = status === 204 || status === 302;
            return new Response(empty ? null : body, { status, headers });
        },
    };
}

async function handleApi(request, url) {
    const handler = ROUTES.get(url.pathname);
    if (!handler) {
        return null;
    }

    const req = await toVercelRequest(request, url);
    const vercelResponse = createVercelResponse();
    await handler(req, vercelResponse.res);
    return vercelResponse.toResponse();
}

async function fetch(request, env) {
    applyWorkerEnv(env);
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
        url.pathname = "/admin.html";
        return env.ASSETS.fetch(new Request(url, request));
    }

    const apiResponse = await handleApi(request, url);
    if (apiResponse) {
        return apiResponse;
    }

    if (env.ASSETS) {
        return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
}

export default {
    fetch,
};
