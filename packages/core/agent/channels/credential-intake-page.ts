import { defineChannel, GET, POST } from "eve/channels";
import { INTAKE_PAGE_PATH, handleIntakePageGet, handleIntakePagePost } from "../credentials/intake-page.js";

export default defineChannel({
  routes: [
    GET(INTAKE_PAGE_PATH, async (req) => handleIntakePageGet(req)),
    POST(INTAKE_PAGE_PATH, async (req) => handleIntakePagePost(req)),
  ],
});
