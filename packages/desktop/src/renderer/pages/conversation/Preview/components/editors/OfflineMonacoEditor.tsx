/** Load the local editor on demand and explain a missing/corrupt asset failure. */
import React, { useEffect, useState } from 'react';
import type { EditorProps } from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';

export default function OfflineMonacoEditor(props: EditorProps): React.ReactElement {
  const { t } = useTranslation();
  const [Editor, setEditor] = useState<React.ComponentType<EditorProps> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import('./localMonaco')
      .then((loaded) => {
        if (active) setEditor(() => loaded.default);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  if (failed) return <span role='alert'>{t('preview.localEditorUnavailable')}</span>;
  if (!Editor) return <span role='status'>{t('common.loading')}</span>;
  return <Editor {...props} />;
}
