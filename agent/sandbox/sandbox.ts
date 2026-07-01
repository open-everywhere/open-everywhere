import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: vercel({
    timeout: 5 * 60 * 1000,
    snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
  }),
});
