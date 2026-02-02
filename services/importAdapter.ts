import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { computeMobileMode } from '../utils/platform';
import { UiMode } from '../types';

export type PickedFile = { name: string; mimeType?: string; size?: number; uri?: string; file?: File };

export interface ImportAdapter {
  pickTextFiles(): Promise<PickedFile[]>;
  pickAudioFiles?(): Promise<PickedFile[]>;
  readText(picked: PickedFile): Promise<string>;
  readBytes(picked: PickedFile): Promise<Uint8Array>;
}

class DesktopImportAdapter implements ImportAdapter {
  async pickTextFiles(): Promise<PickedFile[]> {
    if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
      // Modern picker path
      const handles = await (window as any).showOpenFilePicker({
        types: [
          {
            description: 'Text files',
            accept: {
              'text/plain': ['.txt'],
              'text/markdown': ['.md'],
              'text/html': ['.html', '.htm'],
            },
          },
        ],
        multiple: true,
      });
      const files = await Promise.all(handles.map((h: any) => h.getFile()));
      return files.map((file: File) => ({
        name: file.name,
        mimeType: file.type,
        size: file.size,
        file,
      }));
    }

    // Fallback to hidden input
    return new Promise<PickedFile[]>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.md,.html,.htm';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const list = Array.from(input.files || []).map((file) => ({
          name: file.name,
          mimeType: file.type,
          size: file.size,
          file,
        }));
        document.body.removeChild(input);
        resolve(list);
      };
      input.click();
    });
  }

  async readText(picked: PickedFile): Promise<string> {
    if (picked.file) return picked.file.text();
    if (picked.uri) {
      const res = await fetch(picked.uri);
      return res.text();
    }
    throw new Error('No file to read');
  }

  async readBytes(picked: PickedFile): Promise<Uint8Array> {
    if (picked.file) {
      const buf = await picked.file.arrayBuffer();
      return new Uint8Array(buf);
    }
    if (picked.uri) {
      const res = await fetch(picked.uri);
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error('No file to read');
  }
}

class MobileImportAdapter implements ImportAdapter {
  async pickTextFiles(): Promise<PickedFile[]> {
    const picker = (Capacitor as any)?.Plugins?.CapacitorFilePicker || (Capacitor as any)?.Plugins?.FilePicker;
    if (!picker?.pickFiles) {
      throw new Error('FilePicker plugin not available');
    }
    const res = await picker.pickFiles({
      multiple: true,
      types: ['text/plain', 'text/markdown', 'text/html'],
    });
    const files = res?.files || [];
    return files.map((f: any) => ({
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      uri: f.path || f.uri,
    }));
  }

  async readText(picked: PickedFile): Promise<string> {
    if (picked.file) return picked.file.text();
    if (picked.uri) {
      const res = await Filesystem.readFile({ path: picked.uri });
      if (typeof res.data === 'string') {
        // Capacitor returns base64 for binary; assume utf-8 text here.
        try {
          return atob(res.data);
        } catch {
          return res.data;
        }
      }
    }
    throw new Error('readText failed for mobile');
  }

  async readBytes(picked: PickedFile): Promise<Uint8Array> {
    if (picked.file) {
      const buf = await picked.file.arrayBuffer();
      return new Uint8Array(buf);
    }
    if (picked.uri) {
      const res = await Filesystem.readFile({ path: picked.uri });
      if (res.data instanceof Blob) {
        const buf = await res.data.arrayBuffer();
        return new Uint8Array(buf);
      }
      if (typeof res.data === 'string') {
        const b64 = res.data.includes(',') ? res.data.split(',')[1] : res.data;
        const binary = atob(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }
    }
    throw new Error('readBytes failed for mobile');
  }
}

export function getImportAdapter(uiMode: UiMode): ImportAdapter {
  const isMobile = computeMobileMode(uiMode);
  if (isMobile) return new MobileImportAdapter();
  return new DesktopImportAdapter();
}
