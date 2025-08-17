import React from "react";

/**
 * Some white rectangle that appears over the map and contains information
 */
export function MapOverlayWindow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`absolute lg:w-96 bg-white z-50 left-5 right-5 lg:right-auto border border-gray-500 rounded-sm shadow-md p-2 ${className}`}>
      {children}
    </div>
  );
}
