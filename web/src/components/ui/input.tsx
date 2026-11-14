import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-10 w-full rounded-xl border border-[#e5e5e7] bg-white px-3.5 py-2 text-sm text-[#111111] placeholder:text-[#a3a3a3] focus:outline-none focus:ring-2 focus:ring-[#111111]/15 focus:border-[#111111] disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  />
));
Input.displayName = 'Input';
