"""
Utility functions for serial number metrics calculation.
"""
from app.models.enums import SerialNumberStage


def calculate_completion_metrics(serial_numbers: list) -> tuple[float, dict[str, int]]:
    """
    Calculate completion percentage and stage counts from serial numbers.
    
    Weights: supply=0%, assembly=25%, quality=50%, test=75%, delivery/completed=100%
    
    Returns:
        tuple of (completion_percentage, stage_counts_dict)
    """
    if not serial_numbers:
        return 0.0, {}
    
    # Define stage weights (11 active stages + completed) in production order
    stage_weights = {
        SerialNumberStage.SUPPLY.value: 0,
        SerialNumberStage.ASSEMBLY.value: 9,
        SerialNumberStage.KALITE.value: 18,
        SerialNumberStage.TEST1.value: 27,
        SerialNumberStage.EPOXY.value: 36,
        SerialNumberStage.CONFORMAL.value: 45,
        SerialNumberStage.TEST2.value: 55,
        SerialNumberStage.MONTAJ.value: 64,
        SerialNumberStage.MONTAJ_KALITE.value: 73,
        SerialNumberStage.FINAL_TEST.value: 82,
        SerialNumberStage.DELIVERY.value: 100,
        SerialNumberStage.COMPLETED.value: 100,
    }
    
    # Count serial numbers by stage
    stage_counts: dict[str, int] = {}
    total_weight = 0.0
    
    for sn in serial_numbers:
        current_stage = getattr(sn, "current_stage", SerialNumberStage.SUPPLY.value)
        
        # Count this stage
        stage_counts[current_stage] = stage_counts.get(current_stage, 0) + 1
        
        # Add weight
        weight = stage_weights.get(current_stage, 0)
        total_weight += weight
    
    # Calculate average completion percentage
    count = len(serial_numbers)
    completion_percentage = (total_weight / count / 100) * 100 if count > 0 else 0.0
    
    # Ensure percentage is between 0 and 100
    completion_percentage = min(100.0, max(0.0, completion_percentage))
    
    return completion_percentage, stage_counts
