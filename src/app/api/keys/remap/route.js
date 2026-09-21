import { NextResponse } from "next/server";
import { getRemapForKey, getAllRemaps, setRemapForKey } from "@/lib/keyModelRemapDb";

export const dynamic = "force-dynamic";

// GET /api/keys/remap            -> { remaps: { "<key>": {src: "provider/model"} } }
// GET /api/keys/remap?key=sk-xxx -> { rules: {...} }
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    if (key) return NextResponse.json({ rules: await getRemapForKey(key) });
    return NextResponse.json({ remaps: await getAllRemaps() });
  } catch (error) {
    console.log("Error fetching model remaps:", error);
    return NextResponse.json({ error: "Failed to fetch model remaps" }, { status: 500 });
  }
}

// PUT /api/keys/remap  body: { key, rules }
// Whole-table replace for one key; {} clears it. No DELETE needed.
export async function PUT(request) {
  try {
    const { key, rules } = await request.json();
    const isPlainObject = rules && typeof rules === "object" && !Array.isArray(rules);
    if (typeof key !== "string" || !key || !isPlainObject) {
      return NextResponse.json({ error: "key (string) and rules (object) required" }, { status: 400 });
    }
    await setRemapForKey(key, rules);
    return NextResponse.json({ success: true, rules: await getRemapForKey(key) });
  } catch (error) {
    console.log("Error saving model remaps:", error);
    return NextResponse.json({ error: "Failed to save model remaps" }, { status: 500 });
  }
}
