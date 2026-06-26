import { createContext, useContext, useState } from 'react';

interface ScopeContextType {
  mine: boolean;
  setMine: (v: boolean) => void;
}

const ScopeContext = createContext<ScopeContextType>({ mine: false, setMine: () => {} });

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const [mine, setMine] = useState(false);
  return <ScopeContext.Provider value={{ mine, setMine }}>{children}</ScopeContext.Provider>;
}

export const useScopeContext = () => useContext(ScopeContext);
