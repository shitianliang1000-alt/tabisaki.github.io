## 2023-10-27 - Replace innerHTML with DOM methods to prevent XSS
**Vulnerability:** Use of `innerHTML` in `js/app.js` to render proxy URL error messages, even though `escapeHtml` was used, presents a risk if not careful and goes against the codebase philosophy of avoiding `innerHTML`.
**Learning:** The codebase explicitly documents in `js/ui.js` that `innerHTML` should never be used, as it creates a pathway for XSS if AI-generated text, external data, or user input is rendered. The project provides an `el(tag, attrs, ...children)` helper to create nodes safely.
**Prevention:** Always use `textContent`, `replaceChildren`, or the custom `el` utility when constructing UI elements dynamically in this project.

## 2026-09-07 - Add security headers to proxy servers
**Vulnerability:** Missing strict security headers in API proxies (worker.js and node-proxy.mjs).
**Learning:** API proxy servers should explicitly prevent execution, embedding, and enforce secure transport, even if CORS is properly configured. Relying solely on CORS does not prevent tools or attackers directly calling the proxy server or browsers from caching the contents inappropriately.
**Prevention:** Apply `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, and `Strict-Transport-Security: max-age=31536000` explicitly to API endpoints.

## 2026-09-11 - Add javascript: URI validation to prevent XSS
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` protected against `innerHTML` XSS, but lacked validation for `href` attributes, making it possible for AI-generated or external URLs to inject `javascript:` URIs and execute malicious code upon clicking.
**Learning:** Preventing `innerHTML` usage is not the only vector for XSS; attributes, specifically `href` and `src`, can also carry execution contexts.
**Prevention:** Added robust `v.trim().toLowerCase().startsWith("javascript:")` checking in the `el()` function to neutralize any `href` attribute containing a `javascript:` URI by replacing it with `about:blank`.
## 2026-09-12 - Prevent javascript: URI XSS in admin UI
**Vulnerability:** Similar to js/ui.js, the el() helper in admin/admin.js lacked validation for href attributes, leaving a risk for javascript: URI injection.
**Learning:** When addressing a vulnerability like XSS in a specific utility function, check if the project has duplicated or similar utility functions (e.g. for different scopes like admin vs main UI) that might suffer from the same vulnerability.
**Prevention:** Added javascript: URI check and neutralized it with about:blank in admin/admin.js el() function, same as js/ui.js.
## 2026-09-12 - Prevent URI XSS via control characters in attributes
**Vulnerability:** The javascript: URI check in href attributes could be bypassed using control characters (e.g. \x09 or \x00), and other attributes like src and action were not checked, leading to potential XSS execution. Additionally, vbscript: was not restricted.
**Learning:** Checking for javascript: URIs must account for how browsers parse URLs, specifically by ignoring control characters (ASCII 0-32). Checking only href is insufficient as src and action can also execute code.
**Prevention:** Sanitize href, src, and action attributes by stripping all [\x00-\x20] control characters before matching against javascript: and vbscript:.
## 2026-09-17 - Prevent XSS via data: URIs in attributes
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` and `admin/admin.js` protected against `javascript:` and `vbscript:` URI XSS, but lacked validation for dangerous `data:` URIs (e.g. `data:text/html`). Attackers could exploit this to inject malicious code using `href`, `src`, or `action` attributes.
**Learning:** `data:` URIs can act as a vector for XSS in addition to `javascript:` and `vbscript:`. Allowing arbitrary `data:` URIs, especially those containing text or HTML, presents a security risk. However, completely blocking `data:` URIs breaks legitimate use cases like inline `data:image/` URIs.
**Prevention:** Added check for dangerous `data:` URIs in the `el()` function (excluding `data:image/`) to neutralize them in `href`, `src`, or `action` attributes by replacing them with `about:blank`.
