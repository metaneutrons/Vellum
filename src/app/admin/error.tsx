// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

export default function AdminError({ error, reset }: { error: Error; reset: () => void }) {
  const isDbError = error.message?.includes("connect") ||
    error.message?.includes("ECONNREFUSED") ||
    error.message?.includes("Failed query") ||
    error.message?.includes("timeout");

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">{isDbError ? "🔌" : "⚠️"}</div>
        <h2 className="text-xl font-bold mb-2">
          {isDbError ? "Database Unavailable" : "Something went wrong"}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {isDbError
            ? "Cannot connect to the database. Please check that PostgreSQL is running and accessible."
            : error.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
