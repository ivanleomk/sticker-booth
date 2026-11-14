import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98] cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-[#111111] text-white hover:bg-[#262626] shadow-xs',
        secondary: 'bg-[#f1f1f3] text-[#111111] hover:bg-[#e6e6e9]',
        outline: 'border border-[#e5e5e7] bg-white text-[#111111] hover:bg-[#f7f7f8]',
        ghost: 'text-[#525252] hover:bg-[#f1f1f3] hover:text-[#111111]',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 px-3.5 text-xs',
        lg: 'h-11 px-6 text-sm font-semibold',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = 'Button';
