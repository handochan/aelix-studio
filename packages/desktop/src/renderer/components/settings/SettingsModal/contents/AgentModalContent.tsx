/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import LocalAgents, { type AelixProfilesFocus } from '@/renderer/pages/settings/AgentSettings/LocalAgents';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '../settingsViewContext';

type AgentModalContentProps = {
  /** Expand the builtin Aelix profile list, for example from a deep link. */
  aelixProfiles?: AelixProfilesFocus;
};

const AgentModalContent: React.FC<AgentModalContentProps> = ({ aelixProfiles }) => {
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';

  return (
    <div className='flex flex-col h-full w-full'>
      <AionScrollArea className='flex-1 min-h-0 pb-16px scrollbar-hide' disableOverflow={isPageMode}>
        <LocalAgents aelixProfiles={aelixProfiles} />
      </AionScrollArea>
    </div>
  );
};

export default AgentModalContent;
