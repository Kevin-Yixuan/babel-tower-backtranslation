// Entry point for the standalone import page (mdx/import.html).
// Kept as an external file because MV3 extension pages enforce script-src 'self':
// an inline <script type="module"> would be blocked on chrome-extension:// origins.
import { mountDictionaryPanel } from './dictionary-panel.js';

mountDictionaryPanel(document.querySelector('#root'));
