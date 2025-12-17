
import React, { useState } from 'react';
import { Rule, CaseMode, Scope } from '../types';
import { Plus, Trash2, Edit2, Check, X, Settings2, Info } from 'lucide-react';

interface RuleManagerProps {
  rules: Rule[];
  onAddRule: (rule: Rule) => void;
  onUpdateRule: (rule: Rule) => void;
  onDeleteRule: (id: string) => void;
}

const RuleManager: React.FC<RuleManagerProps> = ({ rules, onAddRule, onUpdateRule, onDeleteRule }) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newRule, setNewRule] = useState<Partial<Rule>>({
    find: '',
    speakAs: '',
    caseMode: CaseMode.IGNORE,
    wholeWord: true,
    scope: Scope.PHRASE,
    priority: 1,
    enabled: true
  });

  const handleSave = () => {
    if (newRule.find && newRule.speakAs) {
      onAddRule({
        ...newRule as Rule,
        id: crypto.randomUUID(),
        priority: newRule.priority || 1,
        enabled: true
      });
      setIsAdding(false);
      setNewRule({
        find: '',
        speakAs: '',
        caseMode: CaseMode.IGNORE,
        wholeWord: true,
        scope: Scope.PHRASE,
        priority: 1,
        enabled: true
      });
    }
  };

  return (
    <div className="p-6 bg-slate-50 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Pronunciation Rules</h2>
          <p className="text-sm text-slate-500">Control how specific words or names are spoken.</p>
        </div>
        {!isAdding && (
          <button 
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all font-semibold shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Add Rule
          </button>
        )}
      </div>

      {isAdding && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-6 animate-in slide-in-from-top duration-300">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Find Text</label>
              <input 
                type="text" 
                value={newRule.find}
                onChange={e => setNewRule({...newRule, find: e.target.value})}
                placeholder="e.g. Fang Yuan"
                className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Speak As</label>
              <input 
                type="text" 
                value={newRule.speakAs}
                onChange={e => setNewRule({...newRule, speakAs: e.target.value})}
                placeholder="e.g. Jack"
                className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Settings2 className="w-4 h-4" /> Case Matching
              </label>
              <div className="flex flex-wrap gap-2">
                {Object.values(CaseMode).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setNewRule({...newRule, caseMode: mode})}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                      newRule.caseMode === mode 
                        ? 'bg-indigo-600 text-white' 
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-700">Whole Word Only</label>
              <button
                onClick={() => setNewRule({...newRule, wholeWord: !newRule.wholeWord})}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ring-offset-2 focus:ring-2 focus:ring-indigo-500 ${
                  newRule.wholeWord ? 'bg-indigo-600' : 'bg-slate-200'
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  newRule.wholeWord ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-700">Priority (Higher First)</label>
              <input 
                type="number" 
                value={newRule.priority}
                onChange={e => setNewRule({...newRule, priority: parseInt(e.target.value) || 1})}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button 
              onClick={() => setIsAdding(false)}
              className="px-4 py-2 text-slate-500 font-semibold hover:text-slate-700 transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={handleSave}
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-bold shadow-md hover:bg-indigo-700"
            >
              Save Rule
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {rules.map(rule => (
          <div key={rule.id} className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 group">
            <div className="flex justify-between items-start mb-2">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm bg-slate-100 px-2 py-1 rounded text-slate-600">"{rule.find}"</span>
                <span className="text-slate-300">→</span>
                <span className="font-bold text-indigo-600">{rule.speakAs}</span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => onDeleteRule(rule.id)}
                  className="p-1.5 text-slate-400 hover:text-red-500 rounded-lg"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-bold uppercase">{rule.caseMode}</span>
              {rule.wholeWord && (
                <span className="text-[10px] bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full font-bold uppercase">Whole Word</span>
              )}
              <span className="text-[10px] bg-slate-50 text-slate-400 px-2 py-0.5 rounded-full font-bold uppercase">Prio: {rule.priority}</span>
            </div>
          </div>
        ))}
        {rules.length === 0 && !isAdding && (
          <div className="col-span-full py-12 text-center bg-white rounded-2xl border-2 border-dashed border-slate-200">
            <Info className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-400">No rules yet. Rules allow you to fix bad pronunciation for names or jargon.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default RuleManager;
