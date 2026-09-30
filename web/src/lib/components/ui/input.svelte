<script>
  import { cn } from "../../utils.js";

  let { class: className = "", value = $bindable(), ...rest } = $props();
</script>

<input
  bind:value
  class={cn(
    "flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
/>
