// Shim → re-export from the SQLite-based DB layer (src/lib/db/), mirroring disabledModelsDb.
export {
  getRemapForKey, getAllRemaps, setRemapForKey,
} from "@/lib/db/index.js";
