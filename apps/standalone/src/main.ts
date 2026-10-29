// Order matters: the runtime installs the in-page fetch and EventSource
// before the dashboard boots. The planet scene is inlined separately (it
// loads three.js through the page's import map).
import "./runtime.ts";
import "../../web/site.js";
import "../../web/app.js";
