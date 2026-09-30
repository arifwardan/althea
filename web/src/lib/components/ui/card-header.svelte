<script>
  import { cn } from "../../utils.js";

  let { class: className = "", children, ...rest } = $props();
</script>

<div class={cn("flex flex-col gap-1 px-4 pt-3", className)} {...rest}>
  {@render children?.()}
</div>
