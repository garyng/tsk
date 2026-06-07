// Vite asset-import suffixes used by the webview bundle (the webview tsconfig
// has `types: []`, so it doesn't pull in `vite/client`'s ambient declarations).
declare module '*?raw' {
    const content: string;
    export default content;
}
declare module '*?inline' {
    const dataUri: string;
    export default dataUri;
}
