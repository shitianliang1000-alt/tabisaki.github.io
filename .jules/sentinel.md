## 2023-10-27 - Replace innerHTML with DOM methods to prevent XSS
**Vulnerability:** Use of `innerHTML` in `js/app.js` to render proxy URL error messages, even though `escapeHtml` was used, presents a risk if not careful and goes against the codebase philosophy of avoiding `innerHTML`.
**Learning:** The codebase explicitly documents in `js/ui.js` that `innerHTML` should never be used, as it creates a pathway for XSS if AI-generated text, external data, or user input is rendered. The project provides an `el(tag, attrs, ...children)` helper to create nodes safely.
**Prevention:** Always use `textContent`, `replaceChildren`, or the custom `el` utility when constructing UI elements dynamically in this project.

## 2026-09-07 - Add security headers to proxy servers
**Vulnerability:** Missing strict security headers in API proxies (worker.js and node-proxy.mjs).
**Learning:** API proxy servers should explicitly prevent execution, embedding, and enforce secure transport, even if CORS is properly configured. Relying solely on CORS does not prevent tools or attackers directly calling the proxy server or browsers from caching the contents inappropriately.
**Prevention:** Apply `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, and `Strict-Transport-Security: max-age=31536000` explicitly to API endpoints.
