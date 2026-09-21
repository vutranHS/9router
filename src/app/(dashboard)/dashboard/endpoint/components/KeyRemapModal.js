"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, ModelSelectModal } from "@/shared/components";

/**
 * Per-key model remap editor.
 *
 * A rule is `<bare source model name>` → `<provider>/<model>`. The source is the
 * bare name because the gateway applies remaps AFTER resolving the model, so one
 * rule catches every spelling of it — `cc/x`, `claude/x`, an alias pointing at
 * it, and combo members.
 */
export default function KeyRemapModal({ isOpen, onClose, apiKey, keyName, rules, onSave, activeProviders, requireApiKey }) {
  const [newSource, setNewSource] = useState("");
  // Which cell the shared picker is writing into: "__new" or an existing source name.
  const [picking, setPicking] = useState(null);

  const entries = Object.entries(rules || {});

  const commit = (next) => onSave(apiKey, next);

  const setTarget = (source, target) => {
    const src = (source || "").trim();
    const tgt = (target || "").trim();
    if (!src || !tgt) return;
    commit({ ...rules, [src]: tgt });
    if (src === newSource.trim()) setNewSource("");
  };

  const removeRule = (source) => {
    const next = { ...rules };
    delete next[source];
    commit(next);
  };

  const handlePick = (model) => {
    if (!picking || model?.isPlaceholder || !model?.value) return;
    setTarget(picking === "__new" ? newSource : picking, model.value);
    setPicking(null);
  };

  const close = () => {
    setNewSource("");
    setPicking(null);
    onClose();
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={close} title={`Model Remap — ${keyName || ""}`} size="lg">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-muted">
            Requests from this key that ask for the source model run the target model instead.
            Matches the model name whichever provider prefix or alias the client used, and applies
            to combo members too. Rules are not chained — point each one at the final target.
          </p>
          {!requireApiKey && (
            <p className="text-xs text-orange-500">
              &ldquo;Require API key&rdquo; is off, so most requests arrive without a key and will not be remapped.
            </p>
          )}

          {entries.length === 0 && (
            <p className="text-xs text-text-muted">No rules yet.</p>
          )}

          {entries.map(([source, target]) => (
            <div key={source} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[12rem_auto_1fr_auto_auto] sm:items-center sm:gap-2">
              <code className="text-xs font-mono truncate" title={source}>{source}</code>
              <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
              <code className="text-xs font-mono text-text-muted truncate" title={target}>{target}</code>
              <button
                onClick={() => setPicking(source)}
                className="text-xs px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-all"
              >
                Change
              </button>
              <button
                onClick={() => removeRule(source)}
                className="p-1 rounded hover:bg-red-500/10 text-red-500 transition-all"
                title="Remove rule"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
              </button>
            </div>
          ))}

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[12rem_auto_1fr_auto_auto] sm:items-center sm:gap-2 border-t border-black/[0.06] dark:border-white/[0.06] pt-3">
            <input
              type="text"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="claude-fable-5-1"
              className="w-full text-xs px-2 py-1.5 rounded bg-black/[0.03] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06] font-mono"
            />
            <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
            <span className="text-xs text-text-muted">pick a target model →</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!newSource.trim()}
              onClick={() => setPicking("__new")}
            >
              Select
            </Button>
            <span />
          </div>
        </div>
      </Modal>

      <ModelSelectModal
        isOpen={!!picking}
        onClose={() => setPicking(null)}
        onSelect={handlePick}
        activeProviders={activeProviders}
        title="Select Target Model"
        closeOnSelect
      />
    </>
  );
}

KeyRemapModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  apiKey: PropTypes.string,
  keyName: PropTypes.string,
  rules: PropTypes.object,
  onSave: PropTypes.func.isRequired,
  activeProviders: PropTypes.array,
  requireApiKey: PropTypes.bool,
};
