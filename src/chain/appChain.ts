import { SnapshotClient } from "./snapshot.ts";
import { PublicData } from "./publicData.ts";
// Browser wiring only. The data readers receive this context explicitly and remain usable outside the app.
import { publicClient, directPublicClient } from "./client";
import { CONFIG } from "./config";
import { BlockClock } from "./blockClock";
import { cubitMarket } from "./market";
import { tabHidden } from "./visibility";
import type { ReadContext } from "./readContext";

export const readContext: ReadContext = { client: publicClient, config: CONFIG };
export const dataClient = CONFIG.dataUrl ? new SnapshotClient(CONFIG.dataUrl) : null;
export const publicData = new PublicData(dataClient ? { client: directPublicClient, config: CONFIG } : readContext, readContext, dataClient);
export const CUBIT = cubitMarket(CONFIG);
export const blockClock = new BlockClock(publicData.readHead);
blockClock.setVisible(!tabHidden());
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => blockClock.setVisible(!tabHidden()));

export const readAllChildren = publicData.children;
export const assertAppBlock = publicData.assertBlock;
