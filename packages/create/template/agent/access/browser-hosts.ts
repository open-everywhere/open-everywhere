import { registerBrowserHosts, type BrowserHostDeclaration } from "@open-everywhere/core/agent/access/browser-hosts.js";

const browserHosts: BrowserHostDeclaration[] = [
  {
    host: "localhost",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    why: "The in-sandbox dev server a worker boots to see its own UI change.",
  },
  {
    host: "127.0.0.1",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    why: "The same in-sandbox dev server, reached by loopback address instead of by name.",
  },
];

registerBrowserHosts(browserHosts);
