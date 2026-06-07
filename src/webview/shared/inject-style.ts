/**
 * Inject a `<style>` element with the given CSS once, keyed by `id` (idempotent
 * across StrictMode's double-invoke and any re-mount). A webview bundle is a
 * single `<script>` with no `<link>` to attach a stylesheet to, so each client
 * ships its CSS as a `?raw` import — a real `.css` file (editor support + Biome
 * formatting) rather than a template literal — and injects it here. The panel
 * CSP permits the inline `<style>` via `style-src 'unsafe-inline'`.
 */
export function injectStyle(id: string, css: string): void {
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
}
