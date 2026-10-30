import { render } from "preact";
import { App } from "@/src/popup/App";

const root = document.getElementById("root");
if (!root) throw new Error("popup root element is missing");

render(<App />, root);
