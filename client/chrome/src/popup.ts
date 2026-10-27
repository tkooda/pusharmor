import { mountPopup } from "../../webext-common/src/ui/popup.ts";
import { uiEnv } from "../../webext-common/src/shellkit.ts";
import { browser } from "./shim.ts";

void mountPopup(uiEnv(browser), document.getElementById("app")!);
