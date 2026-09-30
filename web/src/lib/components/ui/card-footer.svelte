<script>
  import { cn } from "../../utils.js";

  let { class: className = "", children, ...rest } = $props();
</script>

<div class={cn("flex items-center gap-2 border-t border-border px-4 py-2.5", className)} {...rest}>
  {@render children?.()}
</div>
