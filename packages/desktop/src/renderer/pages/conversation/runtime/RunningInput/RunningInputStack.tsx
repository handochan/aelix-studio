/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

type RunningInputStackProps = {
  /** Running-input notices with clickable actions. */
  notices: React.ReactNode;
  /** The turn status bar. It tucks under the composer with `z-1` and a negative bottom margin. */
  children: React.ReactNode;
};

/**
 * Composer layout for running-input notices: they always come before the status bar,
 * which would otherwise paint over their actions and take their pointer events.
 */
const RunningInputStack: React.FC<RunningInputStackProps> = ({ notices, children }) => (
  <>
    {notices}
    {children}
  </>
);

export default RunningInputStack;
