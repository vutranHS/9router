"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [quotaSharing, setQuotaSharing] = useState({ enabled: false, apiKeyIds: [] });
  const [apiKeys, setApiKeys] = useState([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState("");
  const [keysReload, setKeysReload] = useState(0);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
      setSaveError("");
      setQuotaSharing({
        enabled: connection.quotaSharing?.enabled === true,
        apiKeyIds: Array.isArray(connection.quotaSharing?.apiKeyIds) ? connection.quotaSharing.apiKeyIds : [],
      });
    }
  }, [connection, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    setKeysLoading(true);
    setKeysError("");
    setApiKeys([]);
    fetch("/api/keys", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load API keys. Try again.");
        const data = await res.json();
        if (!Array.isArray(data.keys)) throw new Error("Could not load API keys. Try again.");
        if (!controller.signal.aborted) {
          setApiKeys(data.keys.map(({ id, name, isActive }) => ({ id, name, isActive })));
        }
      })
      .catch((error) => { if (!controller.signal.aborted) setKeysError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setKeysLoading(false); });
    return () => controller.abort();
  }, [isOpen, keysReload]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaveError("");
    if (quotaSharing.enabled && (keysLoading || keysError || !quotaSharing.apiKeyIds.length
      || quotaSharing.apiKeyIds.some((id) => !apiKeys.some((key) => key.id === id && key.isActive)))) {
      setSaveError("Select at least one active API key and remove any unavailable keys before saving.");
      return;
    }
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
        quotaSharing,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }
      
      await onSave(updates);
    } catch (error) {
      setSaveError(error.message || "Could not save this connection. Try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose} className="flex flex-col max-h-[90dvh]"
      footer={<div className="w-full">
        {saveError && <p role="alert" className="text-sm text-red-500 mb-3">{saveError}</p>}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        <fieldset className="border-t border-border-subtle pt-4" disabled={saving}>
          <legend className="sr-only">Account quota sharing</legend>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2"
              checked={quotaSharing.enabled}
              onChange={(e) => setQuotaSharing({ ...quotaSharing, enabled: e.target.checked })}
              aria-describedby="quota-sharing-help"
            />
            <span>
              <span className="block text-sm font-semibold">Automatically share account quota</span>
              <span id="quota-sharing-help" className="block text-sm text-text-muted mt-1">
                Only selected API keys can use this account when enabled. Off keeps existing routing.
              </span>
            </span>
          </label>
          {quotaSharing.enabled && (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-sm font-medium">Allowed API keys ({quotaSharing.apiKeyIds.length} selected)</p>
              {keysLoading ? <p className="text-sm text-text-muted" role="status">Loading API keys...</p>
                : keysError ? <div><p className="text-sm text-red-500" role="alert">{keysError}</p><Button variant="ghost" onClick={() => setKeysReload((value) => value + 1)}>Retry loading keys</Button></div>
                : <div className="max-h-48 overflow-y-auto">
                  {apiKeys.length === 0 && <p className="text-sm text-text-muted">No API keys yet. Create one in API Keys, then reopen this connection.</p>}
                  {[...apiKeys, ...quotaSharing.apiKeyIds.filter((id) => !apiKeys.some((key) => key.id === id)).map((id) => ({ id, name: "Deleted API key", isActive: false }))].map((key) => (
                    <label key={key.id} className="flex items-center gap-3 py-2 cursor-pointer text-sm">
                      <input type="checkbox" className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2"
                        checked={quotaSharing.apiKeyIds.includes(key.id)}
                        disabled={!key.isActive && !quotaSharing.apiKeyIds.includes(key.id)}
                        onChange={(e) => setQuotaSharing((current) => ({ ...current, apiKeyIds: e.target.checked ? [...current.apiKeyIds, key.id] : current.apiKeyIds.filter((id) => id !== key.id) }))} />
                      <span className="min-w-0 break-words">{key.name || key.id}{!key.isActive && " (unavailable; remove selection)"}</span>
                    </label>
                  ))}
                </div>}
              <div className="text-sm text-text-muted space-y-2" aria-live="polite">
                {connection.provider === "claude" ? <>
                  <p>Weekly budget: 45% Fable, 45% other models, 10% safety reserve. Fable uses the same weekly allowance, not an extra pool.</p>
                  {quotaSharing.apiKeyIds.length > 0 && <p className="text-text-main">Per key: {(45 / quotaSharing.apiKeyIds.length).toFixed(2)}% weekly for Fable and {(45 / quotaSharing.apiKeyIds.length / 7).toFixed(2)}% per day for other models.</p>}
                </> : <p>Measurable account quota is split equally between selected keys, with a 10% safety reserve and daily release for weekly limits.</p>}
                <details>
                  <summary className="cursor-pointer text-text-main">How estimates and daily limits work</summary>
                  <p className="mt-2">Daily shares follow the account's weekly reset. Unused daily allowance carries forward within that week; future days and other keys cannot be borrowed.</p>
                  <p className="mt-2">Token costs estimate quota use, then adjust using provider measurements. Learning limits requests; missing or stale quota can pause access. Provider limits still apply, including usage outside 9Router.</p>
                  <p className="mt-2">Shared accounts currently support chat only. Other request types are blocked while sharing is enabled.</p>
                  <p className="mt-2">One chat request runs at a time per shared account. Busy requests receive a retry response.</p>
                </details>
              </div>
            </div>
          )}
        </fieldset>

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
    quotaSharing: PropTypes.shape({ enabled: PropTypes.bool, apiKeyIds: PropTypes.arrayOf(PropTypes.string) }),
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
