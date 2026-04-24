"use client";

import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = "📭", title, description, action }: EmptyStateProps) {
  return (
    <div className="px-4 py-16 text-center">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="font-medium text-gray-400 mb-1">{title}</p>
      {description && <p className="text-xs text-gray-500 mb-4">{description}</p>}
      {action}
    </div>
  );
}
