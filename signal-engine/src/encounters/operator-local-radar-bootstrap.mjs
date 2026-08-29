import { createStore } from "../stores/index.mjs";
import { startOperatorLocalRadarIntake } from "./operator-local-radar-intake.mjs";

const store = createStore();
startOperatorLocalRadarIntake({ store });
