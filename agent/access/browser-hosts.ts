import { registerBrowserHosts, type BrowserHostDeclaration } from "@open-everywhere/core/agent/access/browser-hosts.js";

const browserHosts: BrowserHostDeclaration[] = [
  {
    host: "localhost",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    why: "The in-sandbox dev server a worker boots to see its own UI change (the localhost QA loop).",
  },
  {
    host: "127.0.0.1",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    why: "The same in-sandbox dev server, reached by loopback address instead of by name.",
  },

  {
    host: "example.com",
    methods: ["GET", "HEAD"],
    why: "The e2e browser leg's fixed external navigation target (IANA's reserved example domain).",
  },

  {
    host: "my-agent.vercel.app",
    methods: ["GET", "HEAD"],
    why: "This deployment's own web surface — the agent looks at what it ships.",
  },
];

registerBrowserHosts(browserHosts);
