import { mountPage } from "../../webext-common/src/ui/page.ts";
import { uiEnv } from "../../webext-common/src/shellkit.ts";
import { browser } from "./shim.ts";

const root = document.getElementById("app")!;
const go = () => void mountPage(uiEnv(browser), root, location.hash, location.origin);
addEventListener("hashchange", go);
go();
