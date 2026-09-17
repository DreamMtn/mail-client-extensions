/**
 * Why the last call made by "postJsonRpc" did not return a result.
 *
 * A rejected access token and a database we momentarily could not reach both
 * used to end up as the same "http_error_odoo", which is why the add-on kept
 * asking everyone to log out and in for what were only transient failures.
 * They need opposite fixes, so keep them apart.
 */
let _lastCallWasUnauthorized = false;

/**
 * True when Odoo refused the access token of the last call.
 *
 * Odoo never answers a 401: its "outlook" authentication method raises a
 * `BadRequest("Access token invalid")` (`mail_plugin/models/ir_http.py`) which
 * comes back either as an HTTP 400 or, because the plugin routes are JSON-RPC
 * ones, as an HTTP 200 carrying an error payload. Both mention the token, which
 * is what we look for. An "AccessError" is deliberately not matched: it means
 * the user is correctly logged in but lacks the rights on a record, and must
 * not log them out.
 */
function _isUnauthorized(responseCode: number, textResponse: string, dictResponse: any): boolean {
    if (responseCode === 401 || responseCode === 403) {
        return true;
    }

    // "Access token missing" when the header is absent, "Access token invalid"
    // when the API key expired (30 days by default) or was revoked in Odoo.
    if ((textResponse || "").indexOf("Access token ") >= 0) {
        return true;
    }

    const error = dictResponse && dictResponse.error;
    if (!error) {
        return false;
    }

    const exceptionName = "" + ((error.data && error.data.name) || "");
    return (
        exceptionName.indexOf("AccessDenied") >= 0 || exceptionName.indexOf("SessionExpired") >= 0 || error.code === 100 // Odoo "Session expired"
    );
}

/**
 * Error code describing why the last Odoo call failed, to give to `ErrorMessage`.
 */
export function odooErrorCode(): string {
    return _lastCallWasUnauthorized ? "session_expired" : "http_error_odoo";
}

/**
 * Make a JSON RPC call with the following parameters.
 */
export function postJsonRpc(url: string, data = {}, headers = {}, options: any = {}) {
    // Make a valid "Odoo RPC" call
    data = {
        id: 0,
        jsonrpc: "2.0",
        method: "call",
        params: data,
    };

    const httpOptions = {
        method: "post" as GoogleAppsScript.URL_Fetch.HttpMethod,
        contentType: "application/json",
        payload: JSON.stringify(data),
        headers: headers,
        // Without this, any 4xx / 5xx throws and we can not read its status
        // code, which makes an expired login indistinguishable from a database
        // which is down.
        muteHttpExceptions: true,
    };

    _lastCallWasUnauthorized = false;

    try {
        const response = UrlFetchApp.fetch(url, httpOptions);

        if (options.returnRawResponse) {
            return response;
        }

        const responseCode = response.getResponseCode();
        const textResponse = response.getContentText("UTF-8");

        let dictResponse: any = null;
        try {
            dictResponse = JSON.parse(textResponse);
        } catch {
            // An HTML error page (proxy, maintenance page,...) and not an Odoo answer
        }

        const isSuccess = responseCode >= 200 && responseCode <= 299 && dictResponse && dictResponse.result;

        // Only look for an authentication failure once we know the call failed,
        // so that a valid answer is never thrown away because of what it happens
        // to contain.
        if (!isSuccess) {
            _lastCallWasUnauthorized = _isUnauthorized(responseCode, textResponse, dictResponse);
            return;
        }

        return dictResponse.result;
    } catch {
        return;
    }
}

/**
 * Make a JSON RPC call with the following parameters.
 *
 * Try to first read the response from the cache, if not found,
 * make the call and cache the response.
 *
 * The cache key is based on the URL and the JSON data
 *
 * Store the result for 6 hours by default (maximum cache duration)
 *
 * This cache may be needed to make to many HTTP call to an external service (e.g. IAP).
 */
export function postJsonRpcCached(url: string, data = {}, headers = {}, cacheTtl: number = 21600) {
    const cache = CacheService.getUserCache();

    // Max 250 characters, to hash the key to have a fixed length
    const cacheKey =
        "ODOO_HTTP_CACHE_" +
        Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify([url, data])));

    const cachedResponse = cache.get(cacheKey);

    if (cachedResponse) {
        return JSON.parse(cachedResponse);
    }

    const response = postJsonRpc(url, data, headers);

    if (response) {
        cache.put(cacheKey, JSON.stringify(response), cacheTtl);
    }

    return response;
}

/**
 * Take a dictionary and return the URL encoded parameters
 */
export function encodeQueryData(parameters: Record<string, string>): string {
    const queryParameters = [];
    for (let key in parameters) {
        queryParameters.push(encodeURIComponent(key) + "=" + encodeURIComponent(parameters[key]));
    }
    return "?" + queryParameters.join("&");
}
