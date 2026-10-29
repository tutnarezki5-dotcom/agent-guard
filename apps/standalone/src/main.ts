// Order matters: the runtime installs the in-page fetch and EventSource
// before the dashboard boots.
import "./runtime.ts";
import "../../web/app.js";
