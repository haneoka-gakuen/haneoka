import { inject, provide, readonly, type InjectionKey, type Ref } from "vue";

export interface ShellNavigationContext {
  readonly opened: Readonly<Ref<boolean>>;
  open(event: Event): Promise<void>;
}

const shellNavigationKey: InjectionKey<ShellNavigationContext> = Symbol("shell-navigation");

export function provideShellNavigation(opened: Ref<boolean>, open: (event: Event) => Promise<void>) {
  const context: ShellNavigationContext = { opened: readonly(opened), open };
  provide(shellNavigationKey, context);
  return context;
}

export function useShellNavigation(): ShellNavigationContext | null {
  return inject(shellNavigationKey, null);
}
