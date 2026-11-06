#!/usr/bin/env bash
#
# provision_ec2_mac.sh — provision an Apple Silicon Mac on EC2 for the MLX guard.
#
#   bash scripts/provision_ec2_mac.sh --key-name zcode-mac --region us-east-1
#
#   bash scripts/provision_ec2_mac.sh --dry-run
#
# WHAT IT DOES, IN ORDER
# -----------------------
#   1. Checks the instance type is Apple Silicon.  The guard runs on mlx-rs,
#      which needs Metal on an Apple GPU — an Intel Mac cannot run it, so
#      mac1.metal is refused here rather than after you have paid for it.
#   2. Checks the service quota for that family.  A Mac instance runs on a
#      DEDICATED HOST, and the quota for those is per family and usually
#      ZERO on a new account.  If it is zero, this stops and tells you
#      exactly which quota to raise — before anything is billed.
#   3. Finds an availability zone in the region that offers the type.
#   4. Picks the newest AWS arm64 macOS AMI for the version you asked for.
#   5. Allocates the dedicated host, which is the unit of billing.
#   6. Launches the instance on that host.
#   7. Waits for it, and prints the SSH command and the next step.
#
# THE 24-HOUR MINIMUM
# --------------------
#   Apple's macOS licence requires a minimum allocation of 24 hours, so a
#   dedicated host bills for at least a full day whether you use it for
#   five minutes or a week.  This script asks EC2 to auto-release the host
#   after the minimum period (--auto-release 24:00), so a forgotten box
#   does not keep billing forever.
#
#   At the measured on-demand rate for us-east-1:
#       mac2-m2.metal   $0.878/hour  ->  $21.07 for the first day
#       mac-m4.metal    $1.230/hour  ->  $29.52 for the first day
#   The price is per hour and per host, and the instance itself is free.
#
#   Release before 24 hours is refused by AWS
#   (Client.HostMinAllocationPeriodUnexpired), and a host then spends about
#   40 minutes scrubbing before it can be released at all.
#
# --dry-run RUNS THE REAL READ-ONLY STEPS
# -----------------------------------------
#   The quota check, the availability-zone lookup and the AMI lookup are all
#   performed for real in --dry-run.  Only the two calls that cost money —
#   allocate-hosts and run-instances — are skipped.  A dry run that only
#   printed a plan would tell you nothing you could not get by reading this
#   file.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# defaults
# ---------------------------------------------------------------------------
INSTANCE_TYPE="${ZCODE_INSTANCE_TYPE:-mac2-m2.metal}"
REGION="${ZCODE_AWS_REGION:-us-east-1}"
# Whether the operator pinned the region.  If they did not, the script is
# free to move to one that actually has the quota.
REGION_EXPLICIT=0
if [ -n "${ZCODE_AWS_REGION:-}" ]; then
    REGION_EXPLICIT=1
fi
AZ=""
AMI=""
MACOS_VERSION="${ZCODE_MACOS_VERSION:-26}"
KEY_NAME=""
SUBNET_ID=""
SECURITY_GROUP_IDS=""
NAME_TAG="${ZCODE_INSTANCE_NAME:-zcode-guard-mac}"
DRY_RUN=0

# The regions that offer Apple Silicon Mac instance types, measured against
# describe-instance-type-offerings.  The quota is PER REGION, so a family
# can be unavailable in one region and available in another — which is the
# whole reason this script scans when it finds a zero.
MAC_REGIONS="us-east-1 us-east-2 us-west-2 eu-central-1 ap-southeast-2"

# The official AWS macOS images.  They are named like
# amzn-ec2-macos-26.7-20260918-025529-arm64 and are owned by "amazon" —
# the numeric owner id does NOT work through the CLI's --owners flag
# (it silently matches nothing), which is why this is the alias.
MACOS_IMAGE_OWNER="amazon"

# ---------------------------------------------------------------------------
# output helpers — colours only when stdout is a terminal
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'
    C_YEL=$'\033[33m'; C_OFF=$'\033[0m'
else
    C_BOLD=''; C_RED=''; C_GRN=''; C_YEL=''; C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %sok%s   %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%swarning:%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
plan() { printf '    %s[dry-run]%s %s\n' "$C_YEL" "$C_OFF" "$*"; }

usage() {
    cat <<'USAGE'
provision_ec2_mac.sh — provision an Apple Silicon Mac on EC2 for the MLX guard.

  --instance-type <type>  mac2-m2.metal (default) or mac-m4.metal.
                          An Intel Mac (mac1.metal) is refused: the guard
                          needs Metal on an Apple GPU.
  --region <region>       AWS region (default us-east-1).  Apple Silicon
                          Mac types are offered in us-east-1, us-east-2,
                          us-west-2, eu-central-1 and ap-southeast-2.
  --az <az>               availability zone (default: the first that
                          offers the instance type)
  --ami <id>              an explicit AMI (default: the newest AWS arm64
                          macOS image for --macos-version)
  --macos-version <ver>   major macOS version to pick (default 26).  The
                          AWS arm64 images exist for 14, 15, 26 and 27;
                          pick the newest one your toolchain supports.
  --key-name <name>       EC2 key pair for SSH.  Created if it does not
                          exist.
  --subnet-id <id>        subnet in the chosen AZ (default: the default
                          VPC's subnet for that AZ)
  --security-group-ids    security groups (default: a new one that allows
                          SSH from your address)
  --name <tag>            Name tag for the instance
  --dry-run               do every read-only step for real, and only skip
                          the two calls that cost money
  -h, --help              this text
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --instance-type)    INSTANCE_TYPE="$2"; shift 2 ;;
        --region)           REGION="$2"; REGION_EXPLICIT=1; shift 2 ;;
        --az)               AZ="$2"; shift 2 ;;
        --ami)              AMI="$2"; shift 2 ;;
        --macos-version)    MACOS_VERSION="$2"; shift 2 ;;
        --key-name)         KEY_NAME="$2"; shift 2 ;;
        --subnet-id)        SUBNET_ID="$2"; shift 2 ;;
        --security-group-ids) SECURITY_GROUP_IDS="$2"; shift 2 ;;
        --name)             NAME_TAG="$2"; shift 2 ;;
        --dry-run)          DRY_RUN=1; shift ;;
        -h|--help)          usage; exit 0 ;;
        *)                  usage >&2; die "unknown argument: $1" ;;
    esac
done

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
awsq() { aws --region "$REGION" "$@"; }

# The family is what the quota is named after: mac2-m2.metal -> mac2-m2.
family_of() {
    case "$1" in
        *.metal) printf '%s' "${1%.metal}" ;;
        *)       printf '%s' "$1" ;;
    esac
}

# ---------------------------------------------------------------------------
# 1. the machine has to be an Apple Silicon Mac
# ---------------------------------------------------------------------------
log "1. the instance type"
command -v aws >/dev/null 2>&1 || die "the aws CLI is not installed"

arch="$(awsq ec2 describe-instance-types --instance-type "$INSTANCE_TYPE" \
    --query 'InstanceTypes[0].ProcessorInfo.SupportedArchitectures[0]' --output text 2>/dev/null || true)"
if [ -z "$arch" ] || [ "$arch" = "None" ]; then
    die "$INSTANCE_TYPE is not an instance type this account can see in $REGION.
       Apple Silicon Mac types are offered in us-east-1, us-east-2, us-west-2,
       eu-central-1 and ap-southeast-2."
fi
if [ "$arch" != "arm64_mac" ]; then
    die "$INSTANCE_TYPE is '$arch'.  The guard runs on mlx-rs, which needs Metal
       on an Apple GPU — an Intel Mac cannot run it.  Use mac2-m2.metal or
       mac-m4.metal."
fi
vcpu="$(awsq ec2 describe-instance-types --instance-type "$INSTANCE_TYPE" --query 'InstanceTypes[0].VCpuInfo.DefaultVCpus' --output text)"
mem="$(awsq ec2 describe-instance-types --instance-type "$INSTANCE_TYPE" --query 'InstanceTypes[0].MemoryInfo.SizeInMiB' --output text)"
ok "$INSTANCE_TYPE  $vcpu vCPU, $((mem / 1024)) GiB, $arch"

# ---------------------------------------------------------------------------
# 2. the quota — this is the gate that usually stops a new account
# ---------------------------------------------------------------------------
log "2. the service quota"
FAMILY="$(family_of "$INSTANCE_TYPE")"

# The quota for a Mac family is PER REGION: the same account can have none
# in one region and several in another.  So the lookup is a function, and
# it is run again after the region moves.
fetch_quota() {
    QUOTA_ROW="$(awsq service-quotas list-service-quotas --service-code ec2 \
        --query "Quotas[?QuotaName=='Running Dedicated ${FAMILY} Hosts'].[QuotaCode,QuotaName,Value]" \
        --output text 2>/dev/null | head -1)"
    [ -z "$QUOTA_ROW" ] && return 1
    QUOTA_CODE="$(printf '%s' "$QUOTA_ROW" | cut -f1)"
    QUOTA_NAME="$(printf '%s' "$QUOTA_ROW" | cut -f2)"
    QUOTA_VALUE="$(printf '%s' "$QUOTA_ROW" | cut -f3)"
    return 0
}

quota_is_zero() {
    [ "$QUOTA_VALUE" = "0.0" ] || [ "$QUOTA_VALUE" = "0" ]
}

fetch_quota || die "no quota named 'Running Dedicated ${FAMILY} Hosts' in $REGION."

if quota_is_zero; then
    cat >&2 <<EOF

    The quota "$QUOTA_NAME" ($QUOTA_CODE) is 0 in $REGION, so no Mac host can
    be allocated there.  The quota is PER REGION, so it can be zero here and
    available somewhere else.  Looking:

EOF

    ALT_REGION=""
    for r in $MAC_REGIONS; do
        [ "$r" = "$REGION" ] && continue
        v="$(aws --region "$r" service-quotas get-service-quota --service-code ec2 \
            --quota-code "$QUOTA_CODE" --query 'Quota.Value' --output text 2>/dev/null)"
        case "$v" in
            ""|None) v="?" ;;
        esac
        if [ "$v" != "0.0" ] && [ "$v" != "0" ] && [ "$v" != "?" ]; then
            printf '      %-16s %s   <- available\n' "$r" "$v" >&2
            [ -z "$ALT_REGION" ] && ALT_REGION="$r"
        else
            printf '      %-16s %s\n' "$r" "$v" >&2
        fi
    done

    if [ -n "$ALT_REGION" ] && [ "$REGION_EXPLICIT" -eq 0 ]; then
        # Nobody pinned a region, and one of them has the quota.  Move
        # there rather than dying on the default and making the operator
        # read this table and retype the command.
        cat >&2 <<EOF

    $REGION has no quota for $FAMILY but $ALT_REGION does, and no region
    was pinned, so moving there.  Pass --region to choose one yourself.

EOF
        REGION="$ALT_REGION"
        fetch_quota || die "no quota named 'Running Dedicated ${FAMILY} Hosts' in $REGION."
        quota_is_zero && die "the quota in $REGION reads 0 after the move — rerun to see why."
        ok "$QUOTA_NAME = $QUOTA_VALUE  ($QUOTA_CODE) in $REGION"
    else
        cat >&2 <<EOF

    If a region above shows a number above zero, use it:

      bash scripts/provision_ec2_mac.sh --region <that-region> ...

    Otherwise ask for the quota in $REGION (you need permission to request
    quotas):

      aws service-quotas request-service-quota-increase \\
        --region $REGION \\
        --service-code ec2 \\
        --quota-code $QUOTA_CODE \\
        --desired-value 1

    A quota above zero guarantees neither entitlement nor capacity: all
    three checks are separate.

EOF
        if [ "$DRY_RUN" -eq 1 ]; then
            # A dry run allocates nothing, so there is nothing to be
            # protected from.  Carry on so the rest of the plan is visible.
            warn "the quota is 0 in $REGION — the run below would stop here"
        else
            die "nothing was billed.  Use a region with quota, or raise $QUOTA_CODE."
        fi
    fi
else
    ok "$QUOTA_NAME = $QUOTA_VALUE  ($QUOTA_CODE)"
fi

# ---------------------------------------------------------------------------
# 3. the availability zone
# ---------------------------------------------------------------------------
log "3. the availability zone"
if [ -z "$AZ" ]; then
    AZ="$(awsq ec2 describe-instance-type-offerings --location-type availability-zone \
        --filters "Name=instance-type,Values=$INSTANCE_TYPE" \
        --query 'sort_by(InstanceTypeOfferings,&Location)[0].Location' --output text 2>/dev/null)"
    [ -n "$AZ" ] && [ "$AZ" != "None" ] || die "no AZ in $REGION offers $INSTANCE_TYPE."
fi
ok "$AZ"

# ---------------------------------------------------------------------------
# 4. the image
# ---------------------------------------------------------------------------
log "4. the image"
if [ -z "$AMI" ]; then
    # ONE --filters flag on purpose: this CLI build ignores the first filter
    # when two are given, which silently returns the whole image catalogue.
    AMI="$(awsq ec2 describe-images --owners "$MACOS_IMAGE_OWNER" \
        --filters "Name=name,Values=amzn-ec2-macos-${MACOS_VERSION}*-arm64" \
        --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text 2>/dev/null)"
    [ -n "$AMI" ] && [ "$AMI" != "None" ] || die "no arm64 macOS ${MACOS_VERSION} AMI found."
fi
AMI_ID="$(printf '%s' "$AMI" | cut -f1)"
AMI_NAME="$(printf '%s' "$AMI" | cut -f2)"
ok "$AMI_ID  $AMI_NAME"

# ---------------------------------------------------------------------------
# 5. the network
# ---------------------------------------------------------------------------
log "5. the network"
if [ -z "$SUBNET_ID" ]; then
    # ONE --filters flag on purpose — see the note on the AMI lookup.
    SUBNET_ID="$(awsq ec2 describe-subnets --filters "Name=availability-zone,Values=$AZ" \
        --query 'Subnets[0].SubnetId' --output text 2>/dev/null | head -1)"
    [ -n "$SUBNET_ID" ] && [ "$SUBNET_ID" != "None" ] || die "no subnet found in $AZ."
fi
ok "subnet  $SUBNET_ID"

# ---------------------------------------------------------------------------
# 6. the key pair and the security group
# ---------------------------------------------------------------------------
log "6. ssh access"
if [ -z "$KEY_NAME" ]; then
    KEY_NAME="${NAME_TAG}-key"
    info "no --key-name given, using $KEY_NAME"
fi
if awsq ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
    ok "key pair $KEY_NAME exists"
elif [ "$DRY_RUN" -eq 1 ]; then
    plan "create the key pair $KEY_NAME and save the private key"
else
    awsq ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial --output text > "$HOME/.ssh/$KEY_NAME.pem" \
        || die "could not create the key pair"
    chmod 600 "$HOME/.ssh/$KEY_NAME.pem"
    ok "created $KEY_NAME (private key in ~/.ssh/$KEY_NAME.pem)"
fi

if [ -z "$SECURITY_GROUP_IDS" ]; then
    SG_NAME="${NAME_TAG}-sg"
    SG_ID="$(awsq ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | head -1)"
    if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
        SECURITY_GROUP_IDS="$SG_ID"
        ok "security group $SG_NAME ($SG_ID)"
    elif [ "$DRY_RUN" -eq 1 ]; then
        plan "create the security group $SG_NAME allowing SSH from your address"
    else
        MY_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null || echo '')"
        if [ -n "$MY_IP" ]; then
            SG_ID="$(awsq ec2 create-security-group --group-name "$SG_NAME" \
                --description "SSH to the Zcode guard Mac" \
                --vpc-id "$(awsq ec2 describe-subnets --subnet-ids "$SUBNET_ID" --query 'Subnets[0].VpcId' --output text)" \
                --query GroupId --output text)"
            awsq ec2 authorize-security-group-ingress --group-ids "$SG_ID" \
                --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP/32,Description=SSH}]" >/dev/null
            ok "created $SG_NAME ($SG_ID), SSH allowed from $MY_IP"
        else
            die "could not find your public address to open SSH to.  Pass
       --security-group-ids with a group that already allows you."
        fi
        SECURITY_GROUP_IDS="$SG_ID"
    fi
fi

# ---------------------------------------------------------------------------
# 7. the host — this is the unit of billing
# ---------------------------------------------------------------------------
log "7. the dedicated host"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "allocate a dedicated host for $INSTANCE_TYPE in $AZ"
    plan "  --auto-release 24:00   (the 24-hour minimum; after that it releases itself)"
    plan "  this is the thing that bills: one host, one instance, one price"
    printf '\n%s[dry-run]%s nothing was allocated and nothing was billed.\n' "$C_YEL" "$C_OFF"
    printf '           Run without --dry-run to provision the box.\n\n'
    exit 0
fi

HOST_ID="$(awsq ec2 allocate-hosts --instance-type "$INSTANCE_TYPE" \
    --availability-zone "$AZ" --quantity 1 --auto-release 24:00 \
    --tag-specifications "ResourceType=dedicated-host,Tags=[{Key=Name,Value=$NAME_TAG}]" \
    --query 'HostIds[0]' --output text 2>&1)" || die "the host allocation failed:
$HOST_ID
       The quota check above passed, so this is either capacity (no free Mac
       hosts in $AZ right now) or a permissions problem."
[ -n "$HOST_ID" ] && [ "$HOST_ID" != "None" ] || die "the host allocation returned no host id."
ok "host $HOST_ID  (bills from now; auto-releases after the 24-hour minimum)"

# ---------------------------------------------------------------------------
# 8. the instance on that host
# ---------------------------------------------------------------------------
log "8. the instance"
INSTANCE_ID="$(awsq ec2 run-instances --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
    --host-id "$HOST_ID" --subnet-id "$SUBNET_ID" --key-name "$KEY_NAME" \
    --security-group-ids "$SECURITY_GROUP_IDS" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME_TAG}]" \
    --query 'Instances[0].InstanceId' --output text 2>&1)" || die "the launch failed:
$INSTANCE_ID"
[ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] || die "the launch returned no instance id."
ok "instance $INSTANCE_ID"

info "waiting for it to be running"
awsq ec2 wait instance-running --instance-ids "$INSTANCE_ID" \
    || warn "the instance did not reach 'running' in time — check the console"

PUBLIC_DNS="$(awsq ec2 describe-instances --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicDnsName' --output text 2>/dev/null)"

cat <<EOF

    the Mac is booting.  it takes a couple of minutes.

    ssh -i ~/.ssh/$KEY_NAME.pem ec2-user@${PUBLIC_DNS:-<public-dns-name>}

    The default user for the AWS macOS images is ec2-user.  On the box:

      sudo -u \$USER bash scripts/bootstrap_cloud_metal.sh \\
          --domain <your-hostname> --email <your-acme-contact>

    Two things to know:
      * the host bills for at least 24 hours, and releases itself after that
        unless you hold it (aws ec2 describe-hosts);
      * the guard needs a hostname with an A record pointing at the box
        before ACME will issue a certificate.

EOF
