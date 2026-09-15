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
## 2026-09-13 - Enhance URI validation to prevent XSS bypass
**Vulnerability:** The `el()` helper functions in `js/ui.js` and `admin/admin.js` checked `href` for `javascript:` URIs, but failed to strip control characters (like `\x09` tab) before validation, allowing bypasses like `java\x09script:`. It also missed blocking `vbscript:` and did not check `src` or `action` attributes which could also execute scripts.
**Learning:** Checking `href` with `startsWith("javascript:")` is insufficient. Attackers can embed control characters that browsers ignore but validation functions might fail on. Also, other URI attributes (`src`, `action`) and legacy protocols (`vbscript:`) must be sanitized.
**Prevention:** In custom DOM creation functions like `el()`, always strip control characters (`/[\x00-\x1F\x7F-\x9F]/g`) from URI-based attributes (`href`, `src`, `action`) before validating against `javascript:` and `vbscript:`.
