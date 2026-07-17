FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y bash coreutils curl findutils gcc gcc-c++ git gzip make procps-ng python3 ripgrep shadow-utils sudo tar unzip && \
    dnf clean all && \
    useradd -m -s /bin/bash ubuntu && \
    printf 'ubuntu ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/ubuntu && \
    chmod 0440 /etc/sudoers.d/ubuntu

COPY control.py /opt/opensession/control.py
RUN chmod 0755 /opt/opensession/control.py

EXPOSE 8080
USER ubuntu
WORKDIR /home/ubuntu
ENTRYPOINT ["python3", "/opt/opensession/control.py"]
