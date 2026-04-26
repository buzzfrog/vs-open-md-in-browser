import mermaid from '/_assets/mermaid.esm.min.mjs';
const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
mermaid.initialize({ startOnLoad: true, theme, securityLevel: 'strict' });
