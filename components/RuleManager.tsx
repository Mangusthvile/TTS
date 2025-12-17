
import React, { useState, useMemo, useRef } from 'react';
import { Rule, CaseMode, Scope, Theme } from '../types';
import { applyRules } from '../services/speechService';
import { Plus, Trash2, Settings2, Eye, Zap, Download, Upload, X, Save } from 'lucide-react';

interface RuleManagerProps {
  rules: Rule[];
  theme: Theme;
  onAddRule: (rule: Rule) => void;
  onUpdateRule: (rule: Rule) => void;
  onDeleteRule: (id: string) => void;
  onImportRules: (rules: Rule[]) => void;
}

const RuleManager: React.FC<RuleManagerProps> = ({ rules, theme, onAddRule, onUpdateRule, onDeleteRule, onImportRules }) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newRule, setNewRule] = useState<Partial<Rule>>({
    find: '', speakAs: '', caseMode: CaseMode.IGNORE, wholeWord: true, scope: Scope.PHRASE, priority: 1, enabled: true
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const data = JSON.stringify(rules, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `talevox-rules-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) onImportRules(imported);
      } catch (err) { alert("Invalid rule file format."); }
    };
    reader.readAsText(file);
  };

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const labelColor = isDark ? 'text-indigo-400' : 'text-indigo-600';

  return (
    <div className={`p-8 h-full overflow-y-auto transition-colors duration-500 ${isDark ? 'bg-slate-900' : isSepia ? 'bg-[#efe6d5]' : 'bg-slate-50'}`}>
      <div className="max-w-5xl mx-auto space-y-12 pb-32">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <h2 className={`text-3xl font-black tracking-tight ${textClass}`}>Pronunciation Rules</h2>
            <div className="flex gap-8 mt-4">
              <button onClick={handleExport} className={`text-[11px] font-black uppercase tracking-widest flex items-center gap-2 hover:scale-105 transition-transform ${isDark ? 'text-slate-100' : 'text-slate-600'}`}><Download className="w-4 h-4" /> Export</button>
              <button onClick={() => fileInputRef.current?.click()} className={`text-[11px] font-black uppercase tracking-widest flex items-center gap-2 hover:scale-105 transition-transform ${isDark ? 'text-slate-100' : 'text-slate-600'}`}><Upload className="w-4 h-4" /> Import</button>
              <input type="file" ref={fileInputRef} onChange={handleImport} className="hidden" accept=".json" />
            </div>
          </div>
          {!isAdding && (
            <button 
              onClick={() => setIsAdding(true)} 
              className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-2xl shadow-indigo-600/30 flex items-center gap-2 hover:scale-105 active:scale-95 transition-all"
            >
              <Plus className="w-5 h-5" /> New Rule
            </button>
          )}
        </div>

        {isAdding && (
          <div className={`p-8 rounded-[2.5rem] border shadow-2xl animate-in zoom-in-95 duration-200 ${cardBg}`}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div className="space-y-2">
                <label className={`text-[11px] font-black uppercase tracking-widest ml-1 ${labelColor}`}>Find Text</label>
                <input 
                  type="text" 
                  value={newRule.find} 
                  onChange={e => setNewRule({...newRule, find: e.target.value})} 
                  placeholder="e.g. MC" 
                  className={`w-full px-5 py-4 rounded-xl border outline-none font-black ${isDark ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-black'}`} 
                />
              </div>
              <div className="space-y-2">
                <label className={`text-[11px] font-black uppercase tracking-widest ml-1 ${labelColor}`}>Speak As</label>
                <input 
                  type="text" 
                  value={newRule.speakAs} 
                  onChange={e => setNewRule({...newRule, speakAs: e.target.value})} 
                  placeholder="e.g. Master" 
                  className={`w-full px-5 py-4 rounded-xl border outline-none font-black ${isDark ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-black'}`} 
                />
              </div>
            </div>
            <div className="flex justify-end gap-5">
              <button onClick={() => setIsAdding(false)} className={`px-8 py-3 text-xs font-black uppercase tracking-widest ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-black'}`}>Cancel</button>
              <button 
                onClick={() => { 
                  if (!newRule.find || !newRule.speakAs) return;
                  onAddRule({...newRule as Rule, id: crypto.randomUUID()}); 
                  setIsAdding(false); 
                }} 
                className="px-12 py-4 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-widest shadow-xl flex items-center gap-2 hover:bg-indigo-700"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
          </div>
        )}

        {rules.length === 0 ? (
          <div className={`p-20 text-center rounded-[3rem] border-2 border-dashed ${isDark ? 'border-slate-800' : 'border-indigo-600/10'}`}>
            <Zap className={`w-16 h-16 mx-auto mb-6 opacity-40 ${isDark ? 'text-slate-600' : 'text-indigo-600'}`} />
            <h3 className={`text-xl font-black ${textClass}`}>Your Rulebook is Empty</h3>
            <p className={`mt-3 font-bold text-[14px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Add rules to fix mispronounced names or terms unique to your stories.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {rules.map(rule => (
              <div key={rule.id} className={`p-7 rounded-[1.5rem] border transition-all hover:shadow-lg flex items-center justify-between group ${cardBg}`}>
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className={`font-mono text-[13px] font-black truncate px-2 py-0.5 rounded ${isDark ? 'bg-slate-950 text-slate-100' : 'bg-black/5 text-black'}`}>"{rule.find}"</span>
                    <span className="text-indigo-500 font-black">→</span>
                  </div>
                  <span className={`font-black text-xl ${isDark ? 'text-indigo-400' : 'text-indigo-700'} truncate`}>{rule.speakAs}</span>
                </div>
                <button 
                  onClick={() => onDeleteRule(rule.id)} 
                  className={`p-3.5 rounded-xl transition-all ${isDark ? 'text-slate-500 hover:text-red-500 hover:bg-white/10' : 'text-slate-400 hover:text-red-600 hover:bg-black/5'} opacity-0 group-hover:opacity-100`}
                >
                  <Trash2 className="w-5.5 h-5.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RuleManager;
