#!/bin/bash
set -e

# Create CloudWatch alarms for AINX Lambda functions
# 用法: ./scripts/aws-create-alarms.sh <stage>

STAGE="${1:-sit}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"

echo "Creating CloudWatch alarms for stage: $STAGE"

# 创建告警的辅助函数
create_alarm() {
  local alarm_name="$1"
  local metric_name="$2"
  local function_name="$3"
  local description="$4"
  local threshold="$5"
  local period="$6"
  local evaluation_periods="$7"
  
  # 检查告警是否已存在
  if aws cloudwatch describe-alarms --alarm-names "$alarm_name" --region "$AWS_REGION" --query 'MetricAlarms[0].AlarmName' --output text 2>/dev/null | grep -q "$alarm_name"; then
    echo "  Alarm $alarm_name already exists, skipping..."
    return 0
  fi
  
  echo "  Creating alarm: $alarm_name"
  aws cloudwatch put-metric-alarm \
    --alarm-name "$alarm_name" \
    --alarm-description "$description" \
    --metric-name "$metric_name" \
    --namespace AWS/Lambda \
    --statistic Sum \
    --period "$period" \
    --evaluation-periods "$evaluation_periods" \
    --threshold "$threshold" \
    --comparison-operator GreaterThanThreshold \
    --dimensions Name=FunctionName,Value="$function_name" \
    --region "$AWS_REGION"
  echo "  Alarm $alarm_name created"
}

# Lambda 函数列表
FUNCTIONS=(
  "ainx-agent-registration-${STAGE}"
  "ainx-auth-${STAGE}"
  "ainx-agent-rotate-key-${STAGE}"
  "ainx-auth-challenge-${STAGE}"
  "ainx-auth-token-${STAGE}"
  "ainx-auth-refresh-${STAGE}"
  "ainx-auth-revoke-${STAGE}"
  "ainx-jwt-authorizer-${STAGE}"
  "ainx-agent-revoke-${STAGE}"
)

# 为每个函数创建 Errors 和 Throttles 告警
for function_name in "${FUNCTIONS[@]}"; do
  # Errors 告警
  create_alarm \
    "${function_name}-errors" \
    "Errors" \
    "$function_name" \
    "Alarm when ${function_name} error rate exceeds 1" \
    1 \
    300 \
    1
  
  # Throttles 告警
  create_alarm \
    "${function_name}-throttling" \
    "Throttles" \
    "$function_name" \
    "Alarm when ${function_name} is throttled" \
    0 \
    60 \
    1
done

echo ""
echo "CloudWatch alarms created successfully!"
