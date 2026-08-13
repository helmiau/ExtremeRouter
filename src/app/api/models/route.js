import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getCombos, getSettings } from "@/lib/localDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { deriveComboCapabilities, memberCapabilitiesForRef } from "open-sse/providers/comboCapabilities.js";
import { comboToClientCaps, toClientCaps } from "@/shared/utils/modelCaps";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          alias: modelAliases[fullModel] || m.model,
          // Compact client caps (only non-default fields) so the 1352-model
          // catalog stays small on the wire — see shared/utils/modelCaps.js.
          caps: toClientCaps(c),
        };
      });

    // Combos — derive capability from members (union modalities, min limits,
    // strategy-aware thinking) so the dashboard can show a combo-level badge
    // and never has to guess from member names. fullModel = combo name (no
    // slash) keeps the model-name→provider index in the combos page intact.
    let comboStrategyOverrides = {};
    try {
      const settings = await getSettings();
      comboStrategyOverrides = settings?.comboStrategies && typeof settings.comboStrategies === "object"
        ? settings.comboStrategies
        : {};
    } catch {
      // settings unavailable — derive from combo.strategyConfig alone
    }
    let combos = [];
    try {
      combos = await getCombos();
    } catch {
      // no combos — return provider models only
    }
    for (const combo of combos || []) {
      // /api/models is the LLM catalog; media/web combos live on their own routes
      if (combo?.kind && combo.kind !== "llm") continue;
      if (!combo?.name) continue;
      const members = (combo.models || []).map(memberCapabilitiesForRef);
      const strategy = {
        ...(combo.strategyConfig || {}),
        ...(comboStrategyOverrides[combo.name] || {}),
      };
      const derived = deriveComboCapabilities(members, strategy);
      models.push({
        provider: "combo",
        model: combo.name,
        fullModel: combo.name,
        alias: combo.name,
        caps: comboToClientCaps(derived),
      });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
