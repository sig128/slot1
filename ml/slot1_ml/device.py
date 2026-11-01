import torch


def pick_device(requested: str = "auto") -> torch.device:
    """cuda > mps (Apple Silicon) > cpu, unless a device is requested explicitly."""
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")
