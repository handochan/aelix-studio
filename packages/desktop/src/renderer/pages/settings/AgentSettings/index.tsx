/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useSearchParams } from 'react-router-dom';
import AgentModalContent from '@/renderer/components/settings/SettingsModal/contents/AgentModalContent';
import SettingsPageWrapper from '../components/SettingsPageWrapper';

const AgentSettings: React.FC = () => {
  const [searchParams] = useSearchParams();
  const aelixProfiles =
    searchParams.get('aelix') === 'profiles' || searchParams.has('profile')
      ? { expanded: true, profile: searchParams.get('profile') }
      : undefined;
  return (
    <SettingsPageWrapper>
      <AgentModalContent aelixProfiles={aelixProfiles} />
    </SettingsPageWrapper>
  );
};

export default AgentSettings;
